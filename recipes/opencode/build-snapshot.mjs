#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Build opencode's prebuilt warm snapshot (out/opencode.snapshot.gz) off-VM, so a
// consumer can restore a serviceable `opencode serve` in ~3s instead of the ~68s
// cold warmup build. It replays the recipe's `warmup` block: stage out/ into a
// fresh VM, boot node on the serve bundle, drive a host GET of `warmup.ready.path`
// until it answers `warmup.ready.status` (routes + handler + block cache warm),
// snapshot at that instant (snapshotAppReady), serialize (NSN1) and gzip.
//
// This is BUILD tooling — it reaches the sibling nano repo for the emulator + the
// node ELF + the container with the serializer, exactly like capture-golden.mjs
// reaches ../nano/runners/riscv/images/node. It is NOT part of the guest FS or the manifest.
//
// Usage (from the catalog root, after build.sh has populated recipes/opencode/out):
//   NANOVM_WASM=../nano/wasm/nano.wasm node recipes/opencode/build-snapshot.mjs
// Env: NANOVM_WASM (emulator wasm), NANO_NODE (node ELF), NANO_CONTAINER (nanovm.mjs).

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { parseToml } from "../../tools/lib/toml.mjs";

const RECIPE_DIR = dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = resolve(RECIPE_DIR, "../..");
const NANO_ROOT = resolve(CATALOG_ROOT, "../nano");

const wasmPath = process.env.NANOVM_WASM || resolve(NANO_ROOT, "wasm/nano.wasm");
const nodePath = process.env.NANO_NODE || resolve(NANO_ROOT, "runners/riscv/images/node");
const containerPath = process.env.NANO_CONTAINER || resolve(NANO_ROOT, "runners/riscv/host/nanovm.mjs");
for (const [label, p] of [["NANOVM_WASM", wasmPath], ["NANO_NODE", nodePath], ["NANO_CONTAINER", containerPath]]) {
  if (!existsSync(p)) { console.error(`${label} not found: ${p}`); process.exit(2); }
}

const outRoot = resolve(RECIPE_DIR, "out");
if (!existsSync(outRoot)) { console.error(`no out/ — run build.sh first: ${outRoot}`); process.exit(1); }

const recipe = parseToml(readFileSync(resolve(RECIPE_DIR, "recipe.toml"), "utf8"));
const w = recipe.recipe?.warmup ?? recipe.warmup;
if (!w) { console.error("recipe has no [recipe].warmup"); process.exit(1); }
if (!w.snapshot) { console.error("recipe warmup has no `snapshot` artifact name"); process.exit(1); }
if (!w.ready?.port || !w.ready?.path) { console.error("recipe warmup.ready must set { port, path }"); process.exit(1); }

const { NanoVM, serializeSnapshot } = await import(pathToFileURL(containerPath).href);
const wasm = new Uint8Array(readFileSync(wasmPath));
const nodeElf = new Uint8Array(readFileSync(nodePath));

const vm = await NanoVM.create({ ramMB: Number(process.env.NANO_RAM_MB || 1800), wasm });
vm._nodeElf = nodeElf;

// Stage out/ as the guest FS tree (mirror of capture-golden's --tree staging).
(function stage(dir) {
  for (const n of readdirSync(dir)) {
    const abs = join(dir, n);
    const rel = "/" + relative(outRoot, abs);
    if (statSync(abs).isDirectory()) { vm.makeDir(rel); stage(abs); }
    else vm.addFile(rel, new Uint8Array(readFileSync(abs)), 0o644);
  }
})(outRoot);
vm.makeDir("/root/.config/opencode");

const argv = w.argv;
const env = Object.entries(w.env ?? {}).map(([k, v]) => `${k}=${v}`);
const readyRequest = `GET ${w.ready.path} HTTP/1.1\r\nHost:x\r\nConnection:close\r\n\r\n`;

console.error(`[build-snapshot] booting: ${argv.join(" ")}`);
const t0 = Date.now();
const snap = await vm.snapshotAppReady({
  elf: nodeElf, argv, env,
  maxSteps: Number(w.maxSteps || 80_000_000_000),
  readyPort: Number(w.ready.port), readyRequest, readyStatus: Number(w.ready.status ?? 200),
});
console.error(`[build-snapshot] captured (${w.ready.path}=${w.ready.status ?? 200}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const bytes = serializeSnapshot(snap);
const gz = gzipSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { level: 6 });
const outFile = resolve(outRoot, w.snapshot);
writeFileSync(outFile, gz);
console.error(`[build-snapshot] wrote ${relative(CATALOG_ROOT, outFile)}  ${(bytes.length / 1e6).toFixed(0)}MB → gz ${(gz.length / 1e6).toFixed(0)}MB`);
process.exit(0);
