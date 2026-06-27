#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Capture a recipe's conformance golden locally and write it into test/run.json,
// so adding a recipe is: scaffold (new-recipe.mjs) → build (build.sh) → capture
// (this) → PR. Runs the plain conformance pass on the built binary and patches
// expect.exitCode + expect.stdoutSha256.
//
// Usage:
//   NANOVM_WASM=../nano/wasm/nano.min.wasm node tools/capture-golden.mjs <recipe> [--bin path] [--tree dir]

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseToml } from "./lib/toml.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2];
const args = process.argv.slice(3);
const getOpt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
if (!name) { console.error("usage: capture-golden.mjs <recipe> [--bin path] [--tree dir]"); process.exit(2); }

const wasm = process.env.NANOVM_WASM || resolve(ROOT, "../nano/wasm/nano.min.wasm");
if (!existsSync(wasm)) { console.error(`NANOVM_WASM not found: ${wasm} (set NANOVM_WASM)`); process.exit(2); }

const recipeDir = resolve(ROOT, "recipes", name);
const recipe = parseToml(readFileSync(resolve(recipeDir, "recipe.toml"), "utf8"));
const outRoot = resolve(recipeDir, "out");

let bin = getOpt("--bin");
let tree = getOpt("--tree");
if (recipe.runner === "node") {
  // runner=node recipes load the node ELF + stage their tree.
  bin = bin || process.env.NANO_NODE || resolve(ROOT, "../nano/images/node");
  tree = tree || outRoot;
} else if (!bin) {
  for (const f of readdirSync(outRoot)) {
    const p = resolve(outRoot, f);
    if (statSync(p).isFile()) { bin = p; break; }
  }
}
if (!bin || !existsSync(bin)) { console.error(`no binary in ${outRoot} — run build.sh first (or pass --bin)`); process.exit(1); }

const verdictPath = resolve(ROOT, ".capture-verdict.json");
const cargs = [resolve(ROOT, "tools/nano-conformance.mjs"), bin, "--recipe", recipeDir, "--report", verdictPath];
if (tree) cargs.push("--tree", tree);
execFileSync("node", cargs, { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, NANOVM_WASM: wasm } });

const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
if (!verdict.loaded || verdict.faulted || verdict.enosys) {
  console.error(`conformance failed: loaded=${verdict.loaded} faulted=${verdict.faulted} enosys=${verdict.enosys} exit=${verdict.exitCode} — not capturing`);
  process.exit(1);
}

const runPath = resolve(recipeDir, "test/run.json");
const run = JSON.parse(readFileSync(runPath, "utf8"));
// Only capture when the tool exited as the recipe expects (default 0). A
// clean-but-wrong exit (e.g. a tool that bails because a dep/device is missing)
// must NOT silently record a bogus golden — leave it TBD so the failure is loud.
const expectExit = run.expect?.exitCode ?? 0;
if (verdict.exitCode !== expectExit) {
  console.error(`exit ${verdict.exitCode} != expected ${expectExit} — refusing to capture (build/runtime issue); leaving golden TBD`);
  process.exit(1);
}
run.expect.stdoutSha256 = verdict.stdoutSha256;   // keep the recipe's declared exitCode
writeFileSync(runPath, JSON.stringify(run, null, 2) + "\n");
console.error(`captured ${name}: exit ${verdict.exitCode}, sha ${verdict.stdoutSha256}, ${verdict.instructions} insns → ${runPath}`);
