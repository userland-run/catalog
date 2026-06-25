#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Stitch the per-app result objects emitted by verdict-to-result.mjs into a
// single userland-results.json (contract version 1) for the userland.run status
// hub. The envelope fields are filled from the CI environment:
//
//   commit  ← GITHUB_SHA (first 7)      branch  ← GITHUB_REF_NAME (default main)
//   run_id  ← GITHUB_RUN_ID             finished_at ← now (ISO 8601)
//
// Inputs are any mix of result JSON files and/or directories of them. Each input
// may be a single result object, an array of result objects, or a full results
// envelope (its `.results` are spliced in) — so re-merging a previous output is
// harmless.
//
// Usage:
//   node tools/merge-results.mjs <result.json|dir> [more…] \
//        [--out userland-results.json] [--source catalog] [--suite catalog-conformance]

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

function getOpt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const valueFlags = new Set(["--out", "--source", "--suite"]);
const argv = process.argv.slice(2);
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { if (valueFlags.has(argv[i])) i++; continue; }
  inputs.push(argv[i]);
}

const outPath = resolve(getOpt("out", "userland-results.json"));
const source = getOpt("source", "catalog");
const suite = getOpt("suite", "catalog-conformance");

if (inputs.length === 0) {
  console.error("usage: merge-results.mjs <result.json|dir> ... [--out f] [--source s] [--suite s]");
  process.exit(2);
}

// Expand inputs to a flat list of files (a directory contributes its *.json).
const files = [];
for (const inp of inputs) {
  const p = resolve(inp);
  if (!existsSync(p)) { console.error(`skip: not found: ${p}`); continue; }
  if (statSync(p).isDirectory()) {
    for (const name of readdirSync(p).sort()) {
      const fp = resolve(p, name);
      if (name.endsWith(".json") && fp !== outPath) files.push(join(p, name));
    }
  } else if (p !== outPath) {
    files.push(p);
  }
}

const results = [];
for (const f of files) {
  let doc;
  try { doc = JSON.parse(readFileSync(f, "utf8")); }
  catch (e) { console.error(`skip ${f}: invalid JSON (${e.message})`); continue; }
  if (Array.isArray(doc)) results.push(...doc);
  else if (Array.isArray(doc.results)) results.push(...doc.results);
  else results.push(doc);
}

// Stable order by test_id so the published file diffs cleanly run-to-run.
results.sort((a, b) => String(a.test_id).localeCompare(String(b.test_id)));

const commit = (process.env.GITHUB_SHA || "").slice(0, 7) || "0000000";
const out = {
  contract: 1,
  source,
  suite,
  commit,
  branch: process.env.GITHUB_REF_NAME || "main",
  run_id: process.env.GITHUB_RUN_ID || "",
  finished_at: new Date().toISOString(),
  results,
};

writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.error(`[merge-results] ${results.length} result(s) → ${outPath} (source=${source} suite=${suite} commit=${commit})`);
