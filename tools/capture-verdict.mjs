#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Multi-tier conformance capture: produce a verdict.json for a NON-elf recipe by
// running its built artifact on the runner its `kind` targets, then hashing the
// stdout for the golden compare — the same verdict shape package.mjs consumes
// (loaded/exitCode/stdoutSha256/faulted/enosys/instructions/syscalls). elf-app
// recipes stay with capture-golden.mjs (the RISC-V VM path).
//
//   node-app  → run on the HOST Node engine (child_process node).
//   wasm-app  → run on the wasm runner (SDK createNano + registerWasmApp + execWasmApp).
//   boa-app   → run on the Boa sandbox (SDK createNano({scripting}) + evalModule).
//
//   node tools/capture-verdict.mjs <recipe> [--recipes dir] [--out verdict.json]
//        [--wasm-dir <dir with nano.wasm + boa.wasm>]   (default ../nano/wasm)
//
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, cpSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseToml } from "./lib/toml.mjs";
import { sha256hex } from "./lib/manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const getOpt = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const recipeName = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
if (!recipeName) { console.error("usage: capture-verdict.mjs <recipe> [--recipes dir] [--out path] [--wasm-dir dir]"); process.exit(2); }
const recipesDir = resolve(getOpt("--recipes", resolve(ROOT, "recipes")));
const wasmDir = resolve(getOpt("--wasm-dir", process.env.NANO_WASM_DIR || resolve(ROOT, "../nano/wasm")));
const recipeDir = resolve(recipesDir, recipeName);
// verdict.json sits BESIDE out/ (matching the CI artifact layout), never inside
// it — package.mjs treats the first file in out/ as the binary.
const outPath = resolve(getOpt("--out", resolve(recipeDir, "verdict.json")));

const recipe = parseToml(readFileSync(resolve(recipeDir, "recipe.toml"), "utf8"));
const kind = recipe.kind || "elf-app";
const appName = recipe.entrypoint?.argv?.[0] || recipeName;
const run = JSON.parse(readFileSync(resolve(recipeDir, "test", "run.json"), "utf8"));

// The single built artifact in out/ (build.sh produces it).
function findBinary() {
  const outDir = resolve(recipeDir, "out");
  for (const name of readdirSync(outDir)) {
    const p = join(outDir, name);
    if (name !== "verdict.json" && statSync(p).isFile()) return p;
  }
  throw new Error(`no built artifact in ${outDir} — run build.sh first`);
}

// Load fixtures (run.load: {from,to}). `to` is a VFS abs path like "/in/x"; we
// map its directory to `cwd` for the host/node path and use it verbatim for VMs.
function loadEntries() { return Array.isArray(run.load) ? run.load : []; }

// In Node the SDK takes wasm as bytes (a bare string is treated as a URL).
const wasmBytes = (p) => new Uint8Array(readFileSync(p));

async function captureNode() {
  const bin = findBinary();
  // Host cwd mirrors the VFS cwd: fixtures land at <tmp>/<basename(to)>.
  const tmp = resolve(recipeDir, ".verdict-cwd");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const { from, to } of loadEntries()) cpSync(resolve(recipeDir, "test", from), join(tmp, basename(to)));
  const args = (run.cmd || []).slice(1); // drop the app name; the binary is `bin`
  try {
    const stdout = execFileSync("node", [bin, ...args], { cwd: tmp, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
    return { stdout, exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout || Buffer.alloc(0), exitCode: typeof e.status === "number" ? e.status : 1 };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function captureWasm() {
  const bin = findBinary();
  const nanoWasm = resolve(wasmDir, "nano.wasm");
  if (!existsSync(nanoWasm)) throw new Error(`nano.wasm not found in ${wasmDir} (set --wasm-dir)`);
  const { createNano } = await import("@userland-run/nano-sdk");
  const nano = await createNano({ image: { wasm: wasmBytes(nanoWasm) }, crossOriginIsolation: "ignore", ramMB: 512 });
  try {
    await nano.registerWasmApp(appName, new Uint8Array(readFileSync(bin)));
    const cwd = run.cwd || "/";
    try { nano.fs.mkdirp?.(cwd); } catch { /* best effort */ }
    for (const { from, to } of loadEntries()) {
      try { nano.fs.mkdirp?.(dirname(to)); } catch { /* */ }
      nano.fs.writeFile(to, new Uint8Array(readFileSync(resolve(recipeDir, "test", from))));
    }
    const r = await nano.execWasmApp(run.cmd, { cwd });
    return { stdout: Buffer.from(r.stdout || ""), exitCode: r.exitCode ?? 0 };
  } finally {
    await nano.destroy?.();
  }
}

async function captureBoa() {
  const bin = findBinary();
  const boaWasm = resolve(wasmDir, "boa.wasm");
  const nanoWasm = resolve(wasmDir, "nano.wasm");
  if (!existsSync(boaWasm)) throw new Error(`boa.wasm not found in ${wasmDir} (set --wasm-dir)`);
  if (!existsSync(nanoWasm)) throw new Error(`nano.wasm not found in ${wasmDir} (set --wasm-dir)`);
  const { createNano } = await import("@userland-run/nano-sdk");
  // The Boa engine runs inside a nano VM, so an image is required alongside it.
  const nano = await createNano({ image: { wasm: wasmBytes(nanoWasm) }, scripting: { wasm: wasmBytes(boaWasm) }, crossOriginIsolation: "ignore" });
  const captured = [];
  try {
    const eng = await nano.scripting({ expose: { fs: "readonly", run: true }, onStdout: (c) => captured.push(c) });
    await eng.evalModule(readFileSync(bin, "utf8"));
  } finally {
    await nano.destroy?.();
  }
  return { stdout: Buffer.from(captured.join("")), exitCode: 0 };
}

const RUN = { "node-app": captureNode, "wasm-app": captureWasm, "wasm-service": captureWasm, "wasm-component": captureWasm, "boa-app": captureBoa };

if (!RUN[kind]) {
  console.error(`capture-verdict: kind "${kind}" runs on the RISC-V VM — use capture-golden.mjs (elf-app path)`);
  process.exit(2);
}

const { stdout, exitCode } = await RUN[kind]();
const expected = run.expect?.exitCode ?? 0;
const faulted = exitCode !== expected;
const verdict = {
  loaded: true,
  exitCode,
  stdoutSha256: sha256hex(stdout),
  faulted,
  enosys: false,
  syscalls: {},        // n/a off the RISC-V tier
  instructions: 0,     // n/a off the RISC-V tier
  wallMs: 0,
  peakRamMb: 0,
  tier: kind,
  stdoutBytes: stdout.length,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(verdict, null, 2) + "\n");
console.error(`[capture-verdict] ${recipeName} (${kind}): exit=${exitCode} faulted=${faulted} stdout=${stdout.length}B sha=${verdict.stdoutSha256.slice(0, 12)}… → ${outPath}`);
if (faulted) process.exit(1);
