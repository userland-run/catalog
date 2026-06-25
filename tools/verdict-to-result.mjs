#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Turn ONE nano conformance verdict into ONE userland-results.json result
// object (contract version 1). This is the per-app step in the conformance
// workflow: nano-conformance.mjs produces a verdict, this maps it onto the
// status-hub contract, and merge-results.mjs later stitches the per-app objects
// into a single userland-results.json.
//
// The pass/fail decision is delegated to the existing gate (tools/gate.mjs) so
// there is exactly one definition of "conformant": gate accept → "passed",
// gate reject → "failed". The gate is run as a subprocess and its own log is
// echoed for CI, but a rejection is NOT fatal here — a failing recipe still
// produces a well-formed result object (status "failed") so the hub sees it.
//
// Result shape (spec / contract §results[]):
//   { test_id: "recipes/<app>/test/run.json",
//     features: [ <recipe ids…>, "catalog.pipeline.conformance", "catalog.pipeline.gate" ],
//     status: "passed" | "failed", duration_ms: <verdict.wallMs>, retries: 0,
//     trace_url?: <GitHub Actions run url, when GITHUB_RUN_ID is set> }
//
// Usage:
//   node tools/verdict-to-result.mjs <verdict.json> --recipe recipes/<app> \
//        [--syscalls tools/nano-syscalls.json] [--out result.json]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseToml } from "./lib/toml.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Pipeline features every conformance result implicitly proves: the harness ran
// and the gate evaluated it.
const PIPELINE_FEATURES = ["catalog.pipeline.conformance", "catalog.pipeline.gate"];

function getOpt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// First positional that isn't a flag or a flag's value.
const valueFlags = new Set(["--recipe", "--syscalls", "--out"]);
const argv = process.argv.slice(2);
let verdictPath;
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { if (valueFlags.has(argv[i])) i++; continue; }
  verdictPath = argv[i]; break;
}

const recipeDir = resolve(getOpt("recipe", "."));
const syscallsPath = resolve(getOpt("syscalls", resolve(__dirname, "nano-syscalls.json")));
const outPath = getOpt("out");

if (!verdictPath || !existsSync(verdictPath)) {
  console.error("usage: verdict-to-result.mjs <verdict.json> --recipe <dir> [--syscalls f] [--out f]");
  process.exit(2);
}

const app = basename(recipeDir);

// --- features: recipe's [status] features (default the recipe id) + pipeline ids ---
let recipeFeatures = [`catalog.recipe.${app}`];
const tomlPath = resolve(recipeDir, "recipe.toml");
if (existsSync(tomlPath)) {
  const recipe = parseToml(readFileSync(tomlPath, "utf8"));
  const f = recipe.status && recipe.status.features;
  if (Array.isArray(f) && f.length) recipeFeatures = f.map(String);
}
const features = [...new Set([...recipeFeatures, ...PIPELINE_FEATURES])];

// --- status: delegate to the gate (accept → passed, reject → failed) ---
const gate = spawnSync(
  process.execPath,
  [resolve(__dirname, "gate.mjs"), verdictPath, syscallsPath, "--recipe", recipeDir],
  { encoding: "utf8" },
);
if (gate.status === null) {
  console.error(`gate did not run: ${gate.error ? gate.error.message : "unknown error"}`);
  process.exit(2);
}
// Surface the gate's own ACCEPTED/REJECTED reasoning into the CI log.
if (gate.stdout) process.stderr.write(gate.stdout);
if (gate.stderr) process.stderr.write(gate.stderr);
const status = gate.status === 0 ? "passed" : "failed";

const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));

const runId = process.env.GITHUB_RUN_ID;
const repo = process.env.GITHUB_REPOSITORY || "userland-run/catalog";
const result = {
  test_id: `recipes/${app}/test/run.json`,
  features,
  status,
  duration_ms: Number(verdict.wallMs) || 0,
  retries: 0,
  ...(runId ? { trace_url: `https://github.com/${repo}/actions/runs/${runId}` } : {}),
};

const json = JSON.stringify(result, null, 2) + "\n";
if (outPath) {
  writeFileSync(resolve(outPath), json);
  console.error(`[verdict-to-result] ${app}: ${status} (${result.duration_ms}ms) → ${outPath}`);
} else {
  process.stdout.write(json);
}
