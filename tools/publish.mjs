#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Stage 5 — Publish (spec §7). Turns the packaged output into two npm packages
// that jsDelivr then serves as an immutable, content-addressed CDN:
//   @nano-apps/cas@<gen>     the cas/<sha256> blobs (chunks + signed manifests)
//   @nano-apps/index@<gen>   index.json: name@version → manifest sha, signed
//
// Generation is monotonic: gen = (latest published index patch) + 1. Because each
// generation is an immutable npm version, jsDelivr caches it forever; the client
// resolves the newest generation via the jsDelivr versions API (never a mutable
// file). See spec §7.2 and the SDK's cdn.ts.
//
// The cas package is cumulative within a generation: we carry forward the prior
// generation's blobs so every chunk referenced by the current index is present
// at @nano-apps/cas@<gen>. This keeps the client trivial (one generation to fetch
// from) at the cost of package growth; switch to the R2 mirror past npm's 100MB.
//
// Without NODE_AUTH_TOKEN (or with --dry-run) nothing is pushed: the npm package
// dirs are assembled under <dist>/npm/ and `npm publish --dry-run` is run so the
// output is fully inspectable locally.
//
// Usage: node tools/publish.mjs <dist> [--dry-run]
//   env CATALOG_SIGNING_KEY / CATALOG_ED25519_PRIVATE_KEY  (to sign the index)
//   env NODE_AUTH_TOKEN  (npm auth; absent → dry-run)
//   env NANO_VERSION

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeManifest, loadPrivateKey } from "./lib/manifest.mjs";
import { parseToml } from "./lib/toml.mjs";

const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolsDir, "..");

const distDir = process.argv[2] && !process.argv[2].startsWith("--") ? resolve(process.argv[2]) : resolve("dist");
const casDir = resolve(distDir, "cas");
const npmDir = resolve(distDir, "npm");

const token = process.env.NODE_AUTH_TOKEN;
const dryRun = process.argv.includes("--dry-run") || !token;

const secret = process.env.CATALOG_SIGNING_KEY || process.env.CATALOG_ED25519_PRIVATE_KEY;
if (!secret) { console.error("error: CATALOG_SIGNING_KEY (or CATALOG_ED25519_PRIVATE_KEY) not set"); process.exit(1); }
const privateKey = loadPrivateKey(secret);

const nanoVersion = process.env.NANO_VERSION
  || (existsSync(resolve(toolsDir, "nano-syscalls.json")) ? JSON.parse(readFileSync(resolve(toolsDir, "nano-syscalls.json"), "utf8")).nano_version : "0.0.0");

if (!existsSync(resolve(distDir, "manifests.json"))) { console.error(`error: ${distDir}/manifests.json not found — run package.mjs first`); process.exit(1); }
const records = JSON.parse(readFileSync(resolve(distDir, "manifests.json"), "utf8"));

// --- Resolve generation from the published index, best-effort ---
function npmViewVersion(pkg) {
  // A 404 (package not yet published) is normal on the first generation; swallow
  // npm's stderr so it doesn't read like a failure in CI logs.
  try { return execFileSync("npm", ["view", pkg, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
const prevVer = npmViewVersion("@nano-apps/index@latest");
const prevGen = prevVer ? Number(prevVer.split(".").pop()) : 0;
const gen = (Number.isFinite(prevGen) ? prevGen : 0) + 1;
const version = `0.0.${gen}`;
console.error(`generation: ${gen} (prev index version: ${prevVer || "none"})  → npm version ${version}`);

// --- Carry forward the prior index's app map ---
async function fetchPrevIndex() {
  if (!prevVer) return {};
  const url = `https://cdn.jsdelivr.net/npm/@nano-apps/index@${prevVer}/index.json`;
  try {
    const r = await fetch(url);
    if (!r.ok) return {};
    const j = await r.json();
    return j.apps || {};
  } catch { return {}; }
}

// --- Carry forward the prior cas blobs (cumulative cas package) ---
function carryForwardCas() {
  if (!prevVer) return 0;
  let added = 0;
  const tmp = resolve(distDir, ".prevcas");
  try {
    mkdirSync(tmp, { recursive: true });
    // npm pack downloads the tarball; extract its package/cas/* into our casDir.
    const tarName = execFileSync("npm", ["pack", `@nano-apps/cas@${prevVer}`, "--silent"], { cwd: tmp, encoding: "utf8" }).trim();
    execFileSync("tar", ["xzf", tarName], { cwd: tmp });
    const prevCas = resolve(tmp, "package", "cas");
    if (existsSync(prevCas)) {
      for (const sha of readdirSync(prevCas)) {
        const dst = resolve(casDir, sha);
        if (!existsSync(dst)) { cpSync(resolve(prevCas, sha), dst); added++; }
      }
    }
  } catch (e) {
    console.error(`  (could not carry forward prior cas: ${e.message}; publishing current chunks only)`);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  return added;
}

const apps = await fetchPrevIndex();
for (const rec of records) apps[`${rec.name}@${rec.version}`] = rec.manifestSha;
const carried = carryForwardCas();
console.error(`apps in index: ${Object.keys(apps).length} (carried forward ${carried} prior cas blob(s))`);

// --- Topic bundles (bottling): one signed bundle manifest per topic, listing its
// member app refs. Cumulative: carry forward prior bundles' refs and union in the
// current recipes' topics. The CAS already dedups shared chunks across members. ---
async function fetchPrevBundles() {
  const out = {}; // slug -> { topic, apps: Set<ref> }
  if (!prevVer) return out;
  try {
    const idx = await (await fetch(`https://cdn.jsdelivr.net/npm/@nano-apps/index@${prevVer}/index.json`)).json();
    for (const [slug, sha] of Object.entries(idx.bundles || {})) {
      try {
        const bm = await (await fetch(`https://cdn.jsdelivr.net/npm/@nano-apps/cas@${prevVer}/cas/${sha}`)).json();
        out[slug] = { topic: bm.topic || slug, apps: new Set(bm.apps || []) };
      } catch { /* skip a missing bundle */ }
    }
  } catch { /* no prior bundles */ }
  return out;
}

const bundleAcc = await fetchPrevBundles();
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
  ...(Object.keys(bundles).length ? { bundles } : {}),       // "topic-slug" -> bundle manifest sha
  ...(Object.keys(categories).length ? { categories } : {}), // "topic-slug" -> [app refs] (denormalized)
  ...(Object.keys(collections).length ? { collections } : {}), // "slug" -> { title, description, members[] }
};
const { manifest: index } = finalizeManifest(indexCore, privateKey);

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
  name: "@nano-apps/cas", version,
  description: "Content-addressed nano app chunks + manifests (served via jsDelivr).",
  license: "AGPL-3.0-only OR LicenseRef-UEL", files: ["cas"], publishConfig: { access: "public" },
}, null, 2) + "\n");

// index package
writeFileSync(resolve(indexPkg, "index.json"), JSON.stringify(index, null, 2) + "\n");
writeFileSync(resolve(indexPkg, "package.json"), JSON.stringify({
  name: "@nano-apps/index", version,
  description: "Signed nano app catalog index (served via jsDelivr).",
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
  ? `\nDRY RUN complete (no NODE_AUTH_TOKEN or --dry-run). Inspect ${npmDir}. Generation would be ${gen}.`
  : `\nPublished generation ${gen}: @nano-apps/cas@${version} + @nano-apps/index@${version}`);
