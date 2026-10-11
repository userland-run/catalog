#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Stage 5 — Publish (spec §7). Turns the packaged output into two npm packages
// that jsDelivr then serves as an immutable, content-addressed CDN:
//   @userland-run/nano-cas@<gen>     the cas/<sha256> blobs (chunks + signed manifests)
//   @userland-run/nano-catalog@<gen>   index.json: name@version → manifest sha, signed
//
// Generation is monotonic: gen = max(latest cas patch, latest index patch) + 1 —
// taking the max of BOTH packages means a half-finished run (cas@N published,
// index@N failed) cannot wedge the next run on the already-taken N. Because each
// generation is an immutable npm version, jsDelivr caches it forever; the client
// resolves the newest generation via the jsDelivr versions API (never a mutable
// file). See spec §7.2 and the SDK's cdn.ts.
//
// The cas package is cumulative within a generation: we carry forward the prior
// generation's blobs so every chunk referenced by the current index is present
// at @userland-run/nano-cas@<gen>. This keeps the client trivial (one generation to fetch
// from) at the cost of package growth; switch to the R2 mirror past npm's 100MB.
//
// Fail-closed carry-forward: when a previous generation exists, its index and
// cas package are fetched with `npm pack` (no CDN propagation lag), the index and
// every bundle manifest are verified against keys/catalog.pub (+ generation
// check), and before anything is pushed every sha the new index references (app
// manifests, their chunks, bundles) must be present and hash-correct in dist/cas.
// Any failure exits non-zero — we never publish a generation with holes.
//
// Without NODE_AUTH_TOKEN (or with --dry-run) nothing is pushed: the npm package
// dirs are assembled under <dist>/npm/ and `npm publish --dry-run` is run so the
// output is fully inspectable locally.
//
// Usage: node tools/publish.mjs <dist> [--dry-run]
//   env CATALOG_SIGNING_KEY / CATALOG_ED25519_PRIVATE_KEY  (to sign the index)
//   env NODE_AUTH_TOKEN  (npm auth) or CATALOG_PUBLISH=oidc (trusted publishing);
//       neither → dry-run
//   env NANO_VERSION
//   env CATALOG_PREV_PUBLIC_KEY  (optional, raw base64: verify the PREVIOUS
//        generation with this key instead of keys/catalog.pub — key rotation only)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeManifest, loadPrivateKey, loadPublicKeyRaw, verifyManifest } from "./lib/manifest.mjs";
import { parseToml } from "./lib/toml.mjs";

const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolsDir, "..");

const distDir = process.argv[2] && !process.argv[2].startsWith("--") ? resolve(process.argv[2]) : resolve("dist");
const casDir = resolve(distDir, "cas");
const npmDir = resolve(distDir, "npm");

const token = process.env.NODE_AUTH_TOKEN;
// CATALOG_PUBLISH=oidc: publish via npm trusted publishing (GitHub OIDC, no token).
const oidc = process.env.CATALOG_PUBLISH === "oidc";
const dryRun = process.argv.includes("--dry-run") || (!token && !oidc);

const secret = process.env.CATALOG_SIGNING_KEY || process.env.CATALOG_ED25519_PRIVATE_KEY;
if (!secret) { console.error("error: CATALOG_SIGNING_KEY (or CATALOG_ED25519_PRIVATE_KEY) not set"); process.exit(1); }
const privateKey = loadPrivateKey(secret);

const die = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

// The signing key must match the pinned public key, or every client rejects us.
const pubB64 = readFileSync(resolve(root, "keys/catalog.pub"), "utf8").trim();
const publicKey = loadPublicKeyRaw(pubB64);
{
  const derived = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url").toString("base64");
  if (derived !== pubB64) die("CATALOG_SIGNING_KEY does not match keys/catalog.pub — refusing to sign");
}
const prevPublicKey = process.env.CATALOG_PREV_PUBLIC_KEY ? loadPublicKeyRaw(process.env.CATALOG_PREV_PUBLIC_KEY) : publicKey;

const nanoVersion = process.env.NANO_VERSION
  || (existsSync(resolve(toolsDir, "nano-syscalls.json")) ? JSON.parse(readFileSync(resolve(toolsDir, "nano-syscalls.json"), "utf8")).nano_version : "0.0.0");

if (!existsSync(resolve(distDir, "manifests.json"))) { console.error(`error: ${distDir}/manifests.json not found — run package.mjs first`); process.exit(1); }
const records = JSON.parse(readFileSync(resolve(distDir, "manifests.json"), "utf8"));

// --- Resolve generation from BOTH published packages (fail-closed) ---
// Returns the highest published 0.0.<gen> patch, 0 when the package has never
// been published (npm E404), and exits on any other npm/network failure — a
// transient error must not masquerade as "first generation".
function npmMaxGen(pkg) {
  let out;
  try {
    out = execFileSync("npm", ["view", pkg, "versions", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = `${e.stderr || ""}${e.stdout || ""}`;
    if (/E404|404 Not Found/.test(err)) return 0;
    die(`npm view ${pkg} failed: ${err.trim().split("\n").slice(-3).join(" | ") || e.message}`);
  }
  let vs;
  try { vs = JSON.parse(out); } catch { die(`npm view ${pkg}: unparseable output`); }
  const gens = (Array.isArray(vs) ? vs : [vs]).map((v) => Number(String(v).split(".").pop())).filter(Number.isSafeInteger);
  return gens.length ? Math.max(...gens) : 0;
}
const prevGen = npmMaxGen("@userland-run/nano-catalog");   // last COMPLETE generation (index published last)
const casGen = npmMaxGen("@userland-run/nano-cas");
const prevVer = prevGen > 0 ? `0.0.${prevGen}` : null;
const gen = Math.max(prevGen, casGen) + 1;
const version = `0.0.${gen}`;
if (casGen > prevGen) console.error(`note: nano-cas@0.0.${casGen} has no matching index (half-finished earlier run); skipping to ${gen}`);
console.error(`generation: ${gen} (prev index version: ${prevVer || "none"}, latest cas: ${casGen || "none"})  → npm version ${version}`);

// npm pack <spec> into a temp dir and extract it; returns the extracted package/ dir.
const prevTmp = resolve(distDir, ".prev");
function npmPackExtract(spec, sub) {
  const dir = resolve(prevTmp, sub);
  mkdirSync(dir, { recursive: true });
  try {
    const tarName = execFileSync("npm", ["pack", spec, "--silent"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop();
    execFileSync("tar", ["xzf", tarName], { cwd: dir });
  } catch (e) {
    die(`could not fetch ${spec}: ${(e.stderr || e.message || "").toString().trim()}`);
  }
  return resolve(dir, "package");
}

// --- Carry forward + VERIFY the prior index (signature + generation) ---
function loadPrevIndex() {
  if (!prevVer) return null;
  const pkgDir = npmPackExtract(`@userland-run/nano-catalog@${prevVer}`, "index");
  let idx;
  try { idx = JSON.parse(readFileSync(resolve(pkgDir, "index.json"), "utf8")); }
  catch (e) { die(`prev index ${prevVer}: unreadable index.json (${e.message})`); }
  const v = verifyManifest(idx, prevPublicKey);
  if (!v.ok) die(`prev index ${prevVer} failed verification: ${v.reason}`);
  if (idx.generation !== prevGen) die(`prev index ${prevVer} claims generation ${idx.generation}, expected ${prevGen}`);
  if (!idx.apps || typeof idx.apps !== "object" || Array.isArray(idx.apps)) die(`prev index ${prevVer}: missing apps map`);
  return idx;
}

// Execution tier (runner) an artifact kind runs on — mirrors the SDK's kindToTier.
function tierOf(kind) {
  if (kind === "wasm-app" || kind === "wasm-service" || kind === "wasm-component") return "wasm";
  if (kind === "node-app") return "node";
  if (kind === "boa-app") return "boa";
  return "riscv"; // elf-app (default)
}

// --- Carry forward the prior cas blobs (cumulative cas package) ---
function carryForwardCas() {
  if (!prevVer) return 0;
  mkdirSync(casDir, { recursive: true });
  const prevCas = resolve(npmPackExtract(`@userland-run/nano-cas@${prevVer}`, "cas"), "cas");
  if (!existsSync(prevCas)) die(`@userland-run/nano-cas@${prevVer} has no cas/ dir`);
  let added = 0;
  for (const sha of readdirSync(prevCas)) {
    const dst = resolve(casDir, sha);
    if (!existsSync(dst)) { cpSync(resolve(prevCas, sha), dst); added++; }
  }
  return added;
}

const prevIndex = loadPrevIndex();
const apps = { ...(prevIndex ? prevIndex.apps : {}) };
const appMeta = { ...(prevIndex && prevIndex.appMeta ? prevIndex.appMeta : {}) };
for (const rec of records) {
  const ref = `${rec.name}@${rec.version}`;
  apps[ref] = rec.manifestSha;
  const kind = rec.kind || "elf-app";
  appMeta[ref] = { tier: tierOf(kind), kind, abi: rec.abi || (kind === "elf-app" ? "riscv64gc-linux-musl" : "wasm32-wasip1") };
}
// Legacy apps carried forward from a pre-tier index have no meta ⇒ they are all
// RISC-V elf-apps (the only tier that existed then), so default them accordingly.
for (const ref of Object.keys(apps)) {
  if (!appMeta[ref]) appMeta[ref] = { tier: "riscv", kind: "elf-app", abi: "riscv64gc-linux-musl" };
}
const carried = carryForwardCas();
console.error(`apps in index: ${Object.keys(apps).length} (carried forward ${carried} prior cas blob(s))`);

// Read a cas blob from dist/cas and check its content address.
function readCasBlob(sha, what) {
  if (!/^[0-9a-f]{64}$/.test(sha)) die(`${what}: malformed sha ${JSON.stringify(sha)}`);
  const p = resolve(casDir, sha);
  if (!existsSync(p)) die(`${what}: cas blob ${sha} missing from ${casDir}`);
  const bytes = readFileSync(p);
  if (sha256hex(bytes) !== sha) die(`${what}: cas blob ${sha} content does not match its address`);
  return bytes;
}

// --- Topic bundles (bottling): one signed bundle manifest per topic, listing its
// member app refs. Cumulative: carry forward prior bundles' refs and union in the
// current recipes' topics. The CAS already dedups shared chunks across members.
// Prior bundle manifests are read from the carried-forward cas and verified
// (signature + kind + generation) before their refs are re-signed. ---
function loadPrevBundles() {
  const out = {}; // slug -> { topic, apps: Set<ref> }
  if (!prevIndex) return out;
  for (const [slug, sha] of Object.entries(prevIndex.bundles || {})) {
    let bm;
    try { bm = JSON.parse(readCasBlob(sha, `prev bundle ${slug}`).toString("utf8")); }
    catch (e) { die(`prev bundle ${slug} (${sha}): unparseable (${e.message})`); }
    const v = verifyManifest(bm, prevPublicKey);
    if (!v.ok) die(`prev bundle ${slug} (${sha}) failed verification: ${v.reason}`);
    if (bm.kind !== "bundle" || bm.generation !== prevGen) die(`prev bundle ${slug} (${sha}): kind=${bm.kind} generation=${bm.generation}, expected bundle@${prevGen}`);
    out[slug] = { topic: bm.topic || slug, apps: new Set(Array.isArray(bm.apps) ? bm.apps : []) };
  }
  return out;
}

const bundleAcc = loadPrevBundles();
for (const rec of records) {
  for (const topic of (rec.topics || [])) {
    const slug = slugify(topic);
    (bundleAcc[slug] = bundleAcc[slug] || { topic, apps: new Set() }).apps.add(`${rec.name}@${rec.version}`);
  }
}
const bundles = {}; // slug -> bundle manifest sha
for (const [slug, { topic, apps: refs }] of Object.entries(bundleAcc)) {
  const bundleCore = {
    name: slug,
    kind: "bundle",
    topic,
    generation: gen,
    apps: [...refs].sort(),     // member "name@version" refs (dedup chunks at install)
  };
  const { bytes } = finalizeManifest(bundleCore, privateKey); // signed like an app manifest
  const sha = sha256hex(bytes);
  if (!existsSync(resolve(casDir, sha))) writeFileSync(resolve(casDir, sha), bytes);
  bundles[slug] = sha;
}
if (Object.keys(bundles).length) {
  console.error(`bundles: ${Object.entries(bundleAcc).map(([s, b]) => `${s}(${b.apps.size})`).join(", ")}`);
}

// --- Categories (browse facets): denormalized topic-slug -> app refs, from the
// same accumulator that builds the topic bundles (so the slugs match `bundles`).
// Lets clients group apps by category without fetching every bundle manifest. ---
const categories = {};
for (const [slug, { apps: refs }] of Object.entries(bundleAcc)) {
  categories[slug] = [...refs].sort();
}

// --- Collections (hand-curated workflow sets), read from catalog/collections.toml.
// Distinct from categories: an intentional set of apps (by NAME, version-resolved
// at install) — e.g. a Node dev toolchain. Unknown members are dropped (warned);
// an all-unknown collection is skipped. ---
const appNames = new Set(Object.keys(apps).map((k) => k.slice(0, k.lastIndexOf("@"))));
const collections = {};
const collectionsPath = resolve(root, "collections.toml");
if (existsSync(collectionsPath)) {
  const parsed = parseToml(readFileSync(collectionsPath, "utf8"));
  for (const [slug, def] of Object.entries(parsed)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) continue;
    const members = (Array.isArray(def.members) ? def.members : []).map(String);
    const known = members.filter((m) => appNames.has(m));
    const unknown = members.filter((m) => !appNames.has(m));
    if (unknown.length) console.error(`  collection ${slug}: dropping unknown member(s) ${unknown.join(", ")}`);
    if (!known.length) { console.error(`  collection ${slug}: no known members, skipping`); continue; }
    collections[slug] = { title: String(def.title || slug), description: String(def.description || ""), members: known };
  }
  console.error(`collections: ${Object.entries(collections).map(([s, c]) => `${s}(${c.members.length})`).join(", ") || "none"}`);
}

// --- Build + sign index.json (canonicalization sorts keys, so the signature
// covers categories + collections regardless of insertion order) ---
const indexCore = {
  generation: gen,
  nano_min_version: nanoVersion,
  apps,                       // "name@version" -> manifest sha256 (a cas blob)
  appMeta,                    // "name@version" -> { tier, kind, abi } (execution tier, denormalized)
  ...(Object.keys(bundles).length ? { bundles } : {}),       // "topic-slug" -> bundle manifest sha
  ...(Object.keys(categories).length ? { categories } : {}), // "topic-slug" -> [app refs] (denormalized)
  ...(Object.keys(collections).length ? { collections } : {}), // "slug" -> { title, description, members[] }
};
const { manifest: index } = finalizeManifest(indexCore, privateKey);

// --- Completeness: every sha the new index references must be in dist/cas and
// hash-correct — app manifests (signature-verified), their chunks, and bundles. ---
{
  let checkedChunks = 0;
  for (const [ref, sha] of Object.entries(apps)) {
    let m;
    try { m = JSON.parse(readCasBlob(sha, `app ${ref}`).toString("utf8")); }
    catch (e) { die(`app ${ref} (${sha}): unparseable manifest (${e.message})`); }
    if (!verifyManifest(m, publicKey).ok && !verifyManifest(m, prevPublicKey).ok) die(`app ${ref} (${sha}): manifest signature invalid`);
    for (const f of Array.isArray(m.files) ? m.files : []) {
      for (const c of Array.isArray(f.chunks) ? f.chunks : []) { readCasBlob(c, `app ${ref} ${f.path}`); checkedChunks++; }
    }
  }
  for (const [slug, sha] of Object.entries(bundles)) readCasBlob(sha, `bundle ${slug}`);
  console.error(`completeness: ${Object.keys(apps).length} manifest(s), ${checkedChunks} chunk ref(s), ${Object.keys(bundles).length} bundle(s) present + verified`);
}
rmSync(prevTmp, { recursive: true, force: true });

// --- Assemble npm package dirs ---
rmSync(npmDir, { recursive: true, force: true });
const casPkg = resolve(npmDir, "cas");
const indexPkg = resolve(npmDir, "index");
mkdirSync(resolve(casPkg, "cas"), { recursive: true });
mkdirSync(indexPkg, { recursive: true });

// cas package: copy all blobs
let blobCount = 0;
for (const sha of existsSync(casDir) ? readdirSync(casDir) : []) {
  if (sha.startsWith(".")) continue;
  cpSync(resolve(casDir, sha), resolve(casPkg, "cas", sha));
  blobCount++;
}
writeFileSync(resolve(casPkg, "package.json"), JSON.stringify({
  name: "@userland-run/nano-cas", version,
  description: "Content-addressed nano app chunks + manifests (served via jsDelivr).",
  repository: { type: "git", url: "git+https://github.com/userland-run/catalog.git" },
  license: "AGPL-3.0-only OR LicenseRef-UEL", files: ["cas"], publishConfig: { access: "public" },
}, null, 2) + "\n");

// index package
writeFileSync(resolve(indexPkg, "index.json"), JSON.stringify(index, null, 2) + "\n");
writeFileSync(resolve(indexPkg, "package.json"), JSON.stringify({
  name: "@userland-run/nano-catalog", version,
  description: "Signed nano app catalog index (served via jsDelivr).",
  repository: { type: "git", url: "git+https://github.com/userland-run/catalog.git" },
  license: "AGPL-3.0-only OR LicenseRef-UEL", files: ["index.json"], publishConfig: { access: "public" },
}, null, 2) + "\n");

console.error(`assembled npm packages: cas (${blobCount} blobs) + index (${Object.keys(apps).length} apps) at ${npmDir}`);

// --- Publish (or dry-run) ---
const publishArgs = ["publish", "--access", "public"];
if (dryRun) publishArgs.push("--dry-run");
for (const pkg of [casPkg, indexPkg]) {
  console.error(`\n$ npm ${publishArgs.join(" ")}  (cwd ${pkg})`);
  try {
    execFileSync("npm", publishArgs, { cwd: pkg, stdio: "inherit",
      env: { ...process.env, ...(token ? { NODE_AUTH_TOKEN: token } : {}) } });
  } catch (e) {
    if (dryRun) { console.error("  (dry-run publish reported issues; package dir is still assembled for inspection)"); }
    else { console.error(`  publish failed: ${e.message}`); process.exit(1); }
  }
}

console.error(dryRun
  ? `\nDRY RUN complete (no NODE_AUTH_TOKEN/CATALOG_PUBLISH=oidc, or --dry-run). Inspect ${npmDir}. Generation would be ${gen}.`
  : `\nPublished generation ${gen}: @userland-run/nano-cas@${version} + @userland-run/nano-catalog@${version}`);
