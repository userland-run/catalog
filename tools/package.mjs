#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Stage 4 — Package (spec §6). Runs only on green, after merge. For each built
// recipe it: strips the binary, gzip -9's it, FastCDC-chunks the gzip stream,
// sha256's each chunk into cas/<sha256>, assembles the .napp manifest (with the
// conformance block taken from the verdict), and Ed25519-signs it. The signed
// manifest is itself stored as a cas blob (its sha256 is its content address).
//
// Input layout (what the publish job's download-artifact produces):
//   <artifacts>/build-<recipe>/out/<binary>
//   <artifacts>/build-<recipe>/verdict.json
// plus the checked-out repo's recipes/<recipe>/recipe.toml for identity.
//
// Output:
//   <out>/cas/<sha256>        chunk blobs + signed manifest blobs
//   <out>/manifests.json      [{ name, version, manifestSha, size }]  (for publish.mjs)
//
// Usage: node tools/package.mjs <artifacts> --out dist [--recipes recipes]
//   env CATALOG_SIGNING_KEY (or CATALOG_ED25519_PRIVATE_KEY): base64 PKCS8 / PEM
//   env NANO_VERSION: pinned nano runtime version (default from nano-syscalls.json)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, lstatSync, readlinkSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { resolve, dirname, basename, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseToml } from "./lib/toml.mjs";
import { chunk } from "./lib/fastcdc.mjs";
import { finalizeManifest, sha256hex, loadPrivateKey } from "./lib/manifest.mjs";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolsDir, "..");

function getOpt(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }

const artifactsDir = process.argv[2] && !process.argv[2].startsWith("--") ? resolve(process.argv[2]) : resolve("artifacts");
const outDir = resolve(getOpt("--out", "dist"));
const recipesDir = resolve(getOpt("--recipes", resolve(root, "recipes")));

const secret = process.env.CATALOG_SIGNING_KEY || process.env.CATALOG_ED25519_PRIVATE_KEY;
if (!secret) { console.error("error: CATALOG_SIGNING_KEY (or CATALOG_ED25519_PRIVATE_KEY) not set"); process.exit(1); }
const privateKey = loadPrivateKey(secret);

const nanoVersion = process.env.NANO_VERSION
  || (existsSync(resolve(toolsDir, "nano-syscalls.json")) ? JSON.parse(readFileSync(resolve(toolsDir, "nano-syscalls.json"), "utf8")).nano_version : "0.0.0");

const casDir = resolve(outDir, "cas");
mkdirSync(casDir, { recursive: true });

// Best-effort strip: try cross-strip tools, fall back to leaving symbols in.
function tryStrip(bytes) {
  const tools = ["llvm-strip", "riscv64-linux-gnu-strip", "riscv64-linux-musl-strip", "riscv64-unknown-elf-strip"];
  for (const t of tools) {
    try {
      const tmp = resolve(outDir, ".strip.tmp");
      writeFileSync(tmp, bytes);
      execFileSync(t, ["-s", tmp], { stdio: "ignore" });
      const out = readFileSync(tmp);
      try { execFileSync("rm", ["-f", tmp]); } catch {}
      return { bytes: out, tool: t };
    } catch { /* try next */ }
  }
  return { bytes, tool: null };
}

function writeCas(bytes) {
  const sha = sha256hex(bytes);
  const p = resolve(casDir, sha);
  if (!existsSync(p)) writeFileSync(p, bytes);   // dedup: write once
  return sha;
}

const isElf = (b) => b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;

// Package one file → a manifest `files[]` entry (strip if ELF, gzip, FastCDC-chunk).
function packageFile(absPath, installPath, mode) {
  const raw = readFileSync(absPath);
  const bytes = isElf(raw) ? tryStrip(raw).bytes : raw;
  const gz = gzipSync(bytes, { level: 9 });
  const chunks = chunk(gz).map((r) => writeCas(gz.subarray(r.start, r.end)));
  return { path: installPath, mode, compression: "gzip", size: bytes.length, sha256: sha256hex(gz), chunks, _gz: gz.length };
}

// Recursively list regular files under a directory (symlinks skipped — the
// manifest has no symlink type yet; devenv's tools run via regular wrapper scripts).
function* walkFiles(root, base = root) {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { console.error(`  skip symlink ${relative(base, p)} → ${readlinkSync(p)}`); continue; }
    if (st.isDirectory()) { yield* walkFiles(p, base); continue; }
    if (st.isFile()) yield { abs: p, rel: relative(base, p), mode: "0" + (st.mode & 0o777).toString(8) };
  }
}

// Find a recipe's out/ dir + verdict.json in the artifact. The build job uploads
// `recipes/<r>/out/**` + verdict.json, so both may be nested under the artifact
// dir — search recursively for them.
function findBuild(artifactDir) {
  let outRoot = null, verdictPath = null;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = resolve(d, name);
      const st = statSync(p);
      if (st.isFile()) { if (name === "verdict.json" && !verdictPath) verdictPath = p; }
      else if (st.isDirectory()) { if (name === "out" && !outRoot) outRoot = p; else walk(p); }
    }
  };
  walk(artifactDir);
  let binary = null;
  if (outRoot) {
    for (const name of readdirSync(outRoot)) {
      const p = resolve(outRoot, name);
      if (statSync(p).isFile()) { binary = p; break; }
    }
  }
  return { binary, outRoot, verdictPath };
}

const records = [];
const buildDirs = existsSync(artifactsDir)
  ? readdirSync(artifactsDir).map((d) => resolve(artifactsDir, d)).filter((p) => statSync(p).isDirectory())
  : [];

for (const dir of buildDirs) {
  // artifact dir name is "build-<recipe>"
  const recipeName = basename(dir).replace(/^build-/, "");
  // `_`-prefixed recipes are internal conformance smoke tests — conformed for the
  // status hub, but never packaged into the public catalog.
  if (recipeName.startsWith("_")) { console.error(`skip ${recipeName}: internal test recipe`); continue; }
  const recipeTomlPath = resolve(recipesDir, recipeName, "recipe.toml");
  if (!existsSync(recipeTomlPath)) { console.error(`skip ${recipeName}: no recipe.toml`); continue; }
  const recipe = parseToml(readFileSync(recipeTomlPath, "utf8"));
  const { binary, outRoot, verdictPath } = findBuild(dir);
  if (!verdictPath) { console.error(`skip ${recipeName}: no verdict.json`); continue; }
  if (!recipe.multifile && !binary) { console.error(`skip ${recipeName}: no binary in out/`); continue; }
  if (recipe.multifile && !outRoot) { console.error(`skip ${recipeName}: no out/ tree`); continue; }

  const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));

  // Single-binary recipe → one file at its install path. Multi-file recipe
  // (e.g. typescript) → walk out/ as a guest-FS-rooted tree (out/usr/bin/node →
  // /usr/bin/node), one files[] entry per file, lazily installable per-file.
  let files;
  if (recipe.multifile) {
    files = [...walkFiles(outRoot)].map((f) => packageFile(f.abs, "/" + f.rel, f.mode));
  } else {
    const installPath = recipe.entrypoint?.path
      || `/usr/bin/${(recipe.entrypoint?.argv && recipe.entrypoint.argv[0]) || recipeName}`;
    files = [packageFile(binary, installPath, "0755")];
  }
  const totalGz = files.reduce((s, f) => s + f._gz, 0);
  const totalChunks = files.reduce((s, f) => s + f.chunks.length, 0);
  files.forEach((f) => delete f._gz);

  // Marketplace metadata: topic facets (for bottling/browse) + caveat flags
  // (net/mp/big/tty) the spec defines. Carried into the signed manifest so the
  // client and the bundle grouper can read them without the recipe.
  const topics = Array.isArray(recipe.bundle?.topics) ? recipe.bundle.topics.map(String) : [];
  const caveats = recipe.caveats && typeof recipe.caveats === "object"
    ? Object.entries(recipe.caveats).filter(([, v]) => v === true).map(([k]) => k).sort()
    : [];

  const manifestCore = {
    name: recipe.name || recipeName,
    version: String(recipe.version ?? "0.0.0"),
    abi: recipe.abi || "riscv64gc-linux-musl",
    entrypoint: { argv: recipe.entrypoint?.argv || [recipeName], env: recipe.entrypoint?.env || {} },
    files,
    ...(topics.length ? { topics } : {}),
    ...(caveats.length ? { caveats } : {}),
    // App recipe (deps/warmup/run/benignExitCodes/outputFilters) — app-specific
    // provisioning data a generic SDK runner uses; signed with the manifest.
    ...(recipe.recipe ? { recipe: recipe.recipe } : {}),
    conformance: {
      nano_min_version: nanoVersion,
      syscalls_used: Object.keys(verdict.syscalls || {}).map(Number).sort((a, b) => a - b),
      golden_sha256: verdict.stdoutSha256,
      instructions: verdict.instructions,
      tested: true,
    },
    size: totalGz,                      // total transferred (compressed) bytes
  };

  const { manifest, bytes } = finalizeManifest(manifestCore, privateKey);
  const manifestSha = writeCas(bytes);  // signed manifest stored as a cas blob

  records.push({ name: manifest.name, version: manifest.version, manifestSha, size: manifest.size, ...(topics.length ? { topics } : {}) });
  console.error(`packaged ${manifest.name}@${manifest.version}: ${files.length} file(s), ${totalChunks} chunk(s), ` +
    `gz ${(totalGz / 1024 / 1024).toFixed(2)}MB, manifest ${manifestSha.slice(0, 12)}…`);
}

writeFileSync(resolve(outDir, "manifests.json"), JSON.stringify(records, null, 2) + "\n");
console.error(`\nwrote ${records.length} manifest record(s) → ${resolve(outDir, "manifests.json")}`);
console.error(`cas blobs in ${casDir}`);
