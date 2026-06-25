#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// The conformance gate (spec §5.3). A submission passes only if ALL hold; the
// first failure is the rejection reason and the process exits non-zero so CI
// fails the PR with that reason in the log.
//
//   1. Loads.                 verdict.loaded === true
//   2. Exits as expected.     verdict.exitCode === expect.exitCode
//   3. Deterministic+correct. verdict.stdoutSha256 === expect.stdoutSha256
//   4. No fault.              verdict.faulted === false
//   5. Supported syscalls.    verdict.enosys === false AND every syscall used is
//                             present in nano-syscalls.json
//
// Budgets (maxInstructions, maxWallMs) are SOFT: they fail only runaway / slow
// binaries, and are reported but evaluated last.
//
// Usage: node gate.mjs <verdict.json> <nano-syscalls.json> [--recipe <dir>]
//        (expect block read from <recipe>/test/run.json, or pass --expect inline)

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function die(reason) {
  console.error(`REJECTED: ${reason}`);
  process.exit(1);
}

const [verdictPath, syscallsPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const getOpt = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

if (!verdictPath || !existsSync(verdictPath)) die(`verdict file not found: ${verdictPath}`);
if (!syscallsPath || !existsSync(syscallsPath)) die(`nano-syscalls.json not found: ${syscallsPath}`);

const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
const syscallsDoc = JSON.parse(readFileSync(syscallsPath, "utf8"));
const supported = new Set((syscallsDoc.supported || []).map(Number));

const recipeDir = getOpt("--recipe");
let expect = verdict.expect;
if (!expect && recipeDir) {
  const run = JSON.parse(readFileSync(resolve(recipeDir, "test/run.json"), "utf8"));
  expect = run.expect;
}
if (!expect) die("no expected result (pass --recipe <dir> or embed expect in verdict)");

// --- Hard checks, in order. First failure wins. ---

// 1. Loads.
if (verdict.loaded !== true) die("did not load (vm_load_elf failed — bad ELF or unsupported segment)");

// 2. Exit code.
if (Number(verdict.exitCode) !== Number(expect.exitCode))
  die(`exit code ${verdict.exitCode}, expected ${expect.exitCode}`);

// 3. Deterministic + correct golden output.
if (expect.stdoutSha256 && verdict.stdoutSha256 !== expect.stdoutSha256)
  die(`stdout sha256 mismatch (nondeterminism or wrong output)\n  got      ${verdict.stdoutSha256}\n  expected ${expect.stdoutSha256}`);

// 4. No fault.
if (verdict.faulted === true) die("faulted (illegal instruction or bad memory access — narrow with --trace)");

// 5. Supported syscalls only.
if (verdict.enosys === true) die("hit an unimplemented syscall (ENOSYS) — avoid it or file a nano syscall request");
const used = Object.keys(verdict.syscalls || {}).map(Number);
const unsupported = used.filter((nr) => !supported.has(nr));
if (unsupported.length > 0)
  die(`uses syscalls outside the nano set: ${unsupported.sort((a, b) => a - b).join(", ")} (nano ${syscallsDoc.nano_version})`);
if (used.length === 0)
  console.error("WARNING: no syscalls observed — run the trace pass (nano.trace.wasm) so the syscall gate is meaningful");

// --- Soft budgets (reported; fail only on runaway). ---
const warnings = [];
if (expect.maxInstructions && Number(verdict.instructions) > Number(expect.maxInstructions))
  warnings.push(`instructions ${verdict.instructions} > budget ${expect.maxInstructions}`);
if (expect.maxWallMs && Number(verdict.wallMs) > Number(expect.maxWallMs))
  warnings.push(`wallMs ${verdict.wallMs} > budget ${expect.maxWallMs}`);
if (verdict.budgetExceeded) warnings.push("runner hit its hard budget cap (binary may not terminate)");

if (warnings.length) {
  console.error("SOFT BUDGET WARNINGS:");
  for (const w of warnings) console.error(`  - ${w}`);
  // Treat a hard-cap timeout as a failure (runaway binary); pure over-budget is a warning.
  if (verdict.budgetExceeded) die("budget exceeded — binary too slow or non-terminating (optimize or raise the budget with justification)");
}

console.log(`ACCEPTED: loaded, exit ${verdict.exitCode}, golden ${String(verdict.stdoutSha256).slice(0, 12)}…, ${used.length} syscalls, ${verdict.instructions} insns, ${verdict.wallMs}ms`);
process.exit(0);
