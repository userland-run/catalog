#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Headless nano conformance runner. Loads a candidate static RV64GC ELF on the
// real nano WASM runtime — the exact build that ships to browsers — and emits a
// machine-readable verdict. This is `nano/test/run.mjs` distilled to a library
// with: a deterministic clock + seeded RNG (so golden stdout is reproducible),
// a separated stdout/stderr capture, and per-syscall coverage counting.
//
// Two passes (see the catalog publish.yml):
//   NANOVM_WASM=nano.min.wasm   node nano-conformance.mjs <elf> --recipe <dir> --report verdict.json
//   NANOVM_WASM=nano.trace.wasm node nano-conformance.mjs <elf> --recipe <dir> --trace --merge verdict.json
//
// The first proves pass/fail + golden output + budgets on the plain runtime; the
// second fills in the syscall map from nano.trace.wasm's per-syscall debug_log.
//
// Verdict shape (spec §5.2):
//   { loaded, exitCode, stdoutSha256, faulted, enosys,
//     syscalls: { "<nr>": count, ... }, instructions, wallMs, peakRamMb }
//
// Two run.json knobs let otherwise-nondeterministic tools be conformed:
//   "stdin": "<string>" | ["chunk", ...]   — seeds the guest's stdin so read(0)
//        returns it (then EOF). Lets filter/interactive tools (fzf --filter, less)
//        produce a stable golden.
//   "net": [{ "url": "https://…", "response": "fixtures/resp.bin" }]  — record/replay
//        for NET tools (curl/wget shims) that talk to the host /dev/__net__ device.
//        Instead of a live fetch, the harness replays the recorded fixture bytes,
//        framed as an HTTP/1.1 response, so NET tools golden-conform. The fixture
//        path resolves like `load[].from` (relative to the recipe's test/ dir). A
//        fixture that already begins with "HTTP/1.1 " is served verbatim; otherwise
//        it is treated as the raw body and wrapped in a synthetic 200. A url of "*"
//        is a catch-all; an unmatched url replays a deterministic 404.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemFS } from "./vendor/memfs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deterministic host environment — the key to a stable golden stdoutSha256.
const FROZEN_EPOCH_MS = 1_735_689_600_000; // 2025-01-01T00:00:00Z, fixed
function makeSeededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    // mulberry32 — small, deterministic float in [0,1)
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- VM struct offsets (must match nano/src/types.rs; same as run.mjs) ----
const OFF_SP = 16;          // x[2]
const OFF_A0 = 80;          // x[10]
const OFF_BRK_START = 560;  // brk/memory block
const OFF_BRK_CURRENT = 568;
const OFF_STATUS = 528;
const OFF_CWD = 3680;
const FD_TABLE_OFF = 600, FD_ENTRY_SIZE = 24, MAX_FDS = 64;
const FD_TYPE_NONE = 0, FD_TYPE_STDIN = 1, FD_TYPE_STDERR = 3, FD_TYPE_FILE = 4, FD_TYPE_DIR = 5, FD_TYPE_PIPE = 6;

// FS_PENDING syscall numbers (RISC-V Linux)
const SYS_GETCWD = 17, SYS_MKDIRAT = 34, SYS_UNLINKAT = 35, SYS_FACCESSAT = 48,
      SYS_OPENAT = 56, SYS_CLOSE = 57, SYS_GETDENTS64 = 61, SYS_LSEEK = 62,
      SYS_READ = 63, SYS_WRITE = 64, SYS_PREAD64 = 67, SYS_PWRITE64 = 68, SYS_PREADV = 69, SYS_PWRITEV = 70,
      SYS_PPOLL = 73,
      SYS_READLINKAT = 78, SYS_NEWFSTATAT = 79, SYS_FSTAT = 80,
      SYS_UTIMENSAT = 88, SYS_RENAMEAT2 = 276, SYS_STATX = 291;

// Seeded-stdin feed chunk: must stay <= the guest tty ring capacity (8192) so a
// push into an empty ring never overflows/drops bytes.
const STDIN_CHUNK = 4096;

/**
 * Run one conformance pass.
 * @param {object} o
 * @param {string} o.wasmPath  path to nano.min.wasm or nano.trace.wasm
 * @param {Uint8Array} o.elf   candidate ELF bytes
 * @param {object} o.run       parsed run.json
 * @param {string} o.recipeDir recipe directory (to resolve `load` fixtures)
 * @returns {object} verdict
 */
export async function runPass({ wasmPath, elf, run, recipeDir, treeDir }) {
  const wasmBytes = readFileSync(wasmPath);
  const ramMb = Number(run.ramMb) > 0 ? Number(run.ramMb) : 1024;
  const RAM_SIZE = ramMb * 1024 * 1024;
  const ramPages = Math.max(3072, Math.floor(RAM_SIZE / 65536)); // >= module initial
  const memory = new WebAssembly.Memory({ initial: ramPages, maximum: 32768, shared: true });

  // Capture stdout/stderr as bytes (stdout is hashed for the golden compare).
  const stdoutChunks = [];
  const stderrChunks = [];
  const syscalls = {};
  const rand = makeSeededRandom(0xC0FFEE);
  let aborted = false;

  const imports = {
    env: {
      memory,
      abort_js() { aborted = true; throw new Error("abort_js"); },
      debug_log(v) {
        if (((v >>> 24) & 0xff) === 0x0a) {
          const nr = v & 0xffff;
          syscalls[nr] = (syscalls[nr] || 0) + 1;
        }
      },
      emscripten_random() { return rand(); },
      emscripten_date_now() { return FROZEN_EPOCH_MS; },
      console_write(fd, ptr, len) {
        const bytes = new Uint8Array(memory.buffer.slice(ptr, ptr + len));
        if (fd === 2) stderrChunks.push(bytes); else stdoutChunks.push(bytes);
      },
    },
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const X = instance.exports;

  const vmPtr = X.vm_create(RAM_SIZE);
  if (vmPtr === 0) {
    return verdict({ loaded: false, exitCode: -1, stdout: [], stderr: stderrChunks, faulted: true,
                     enosys: false, syscalls, instructions: 0, wallMs: 0, peakRamMb: 0 });
  }
  const ramPtr = X.vm_ram_ptr(vmPtr);

  // Load the candidate ELF at guest offset 0.
  new Uint8Array(memory.buffer).set(elf, ramPtr);
  const loadRc = X.vm_load_elf(vmPtr, 0, elf.length);
  if (loadRc !== 0) {
    return verdict({ loaded: false, exitCode: -1, stdout: [], stderr: stderrChunks, faulted: false,
                     enosys: false, syscalls, instructions: 0, wallMs: 0, peakRamMb: 0 });
  }

  const dv = new DataView(memory.buffer);
  setupStack(dv, memory, ramPtr, vmPtr, RAM_SIZE, run.cmd || ["app"], run.env || {});

  const memfs = seedFs(RAM_SIZE, ramMb);
  // `load[].from` is relative to the recipe's test/ dir (where run.json lives),
  // matching the spec — e.g. "fixtures/corpus.txt".
  const testDir = resolve(recipeDir, "test");
  loadFixtures(memfs, run.load || [], testDir);
  if (treeDir) loadTree(memfs, treeDir);

  // Deterministic I/O fixtures: seeded stdin (M1) and NET record/replay (B3).
  const io = { stdin: buildStdin(run.stdin), net: buildNetState(run.net, testDir) };

  // Seed stdin into the in-VM tty ring. Interactive mode makes an empty read park
  // (FS_PENDING) instead of EOF-ing immediately, so the run loop can feed the
  // remaining chunks incrementally (the ring is only 8192 bytes). The first chunk
  // is pushed up front; the rest follow on each park, then EOF.
  if (io.stdin) {
    if (typeof X.vm_stdin_set_interactive === "function") X.vm_stdin_set_interactive(vmPtr, 1);
    feedStdin(X, memory, vmPtr, io.stdin);
  }

  // ---- exec loop ----
  // Exact instruction count comes from nano's block-cache counters
  // (block_insns + baseline_insns), which start at 0 for a fresh VM. Far more
  // precise than the per-step budget delta, which is granular to one BUDGET.
  const totalInsns = () => {
    if (typeof X.debug_block_insns !== "function") return 0;
    return Number(X.debug_block_insns()) + Number(X.debug_baseline_insns());
  };
  let enosys = false;
  let faulted = false;
  let exitCode = -1;
  let instructions = 0;
  const BUDGET = 1_000_000;
  const maxInstr = Number(run?.expect?.maxInstructions) > 0 ? Number(run.expect.maxInstructions) : 5e9;
  const hardInstrCap = maxInstr * 2;        // bound runaway; gate soft-fails on the real count
  const maxWallMs = Number(run?.expect?.maxWallMs) > 0 ? Number(run.expect.maxWallMs) : 60_000;
  const hardWallMs = maxWallMs * 2;
  const t0 = Date.now();
  let budgetExceeded = false;

  for (;;) {
    instructions = totalInsns();
    if (instructions >= hardInstrCap || (Date.now() - t0) >= hardWallMs) { budgetExceeded = true; break; }
    try {
      X.vm_step(vmPtr, BUDGET);
    } catch (e) {
      faulted = true;
      break;
    }
    const status = X.debug_status(vmPtr);

    if (status === 3) {
      exitCode = X.vm_exit_code(vmPtr);
      if (X.debug_fault_pc(vmPtr) !== 0n && X.debug_fault_pc(vmPtr) !== 0) faulted = true;
      break;
    }
    if (status === 6) {
      // A parked stdin read/ppoll (only with seeded stdin) is fed from the
      // run.json buffer and retried in-VM — it never goes through the FS bridge.
      // Each feed makes progress (next chunk, else EOF) so it cannot hang.
      if (io.stdin && isStdinPark(X, dv, vmPtr)) {
        feedStdin(X, memory, vmPtr, io.stdin);
        X.vm_io_retry(vmPtr);
        continue;
      }
      const nr = processFsRequest(X, dv, memory, ramPtr, vmPtr, memfs, io);
      if (nr === -38) enosys = true;
      continue;
    }
    if (status === 7) {                       // EPOLL_BLOCKED → EINTR, keep going
      dv.setBigInt64(vmPtr + OFF_A0, -4n, true);
      dv.setInt32(vmPtr + OFF_STATUS, 0, true);
      continue;
    }
    if (status !== 0 && status !== 18) { faulted = true; break; }
  }

  instructions = totalInsns() || instructions;
  const wallMs = Date.now() - t0;
  const peakRamMb = readPeakRamMb(dv, vmPtr);

  return verdict({
    loaded: true, exitCode, stdout: stdoutChunks, stderr: stderrChunks,
    faulted: faulted || aborted, enosys, syscalls, instructions, wallMs, peakRamMb, budgetExceeded,
  });
}

function verdict({ loaded, exitCode, stdout, stderr, faulted, enosys, syscalls, instructions, wallMs, peakRamMb, budgetExceeded = false }) {
  const stdoutBytes = concat(stdout);
  const stderrBytes = concat(stderr);
  return {
    loaded,
    exitCode,
    stdoutSha256: sha256hex(stdoutBytes),
    faulted,
    enosys,
    syscalls: Object.fromEntries(Object.entries(syscalls).map(([k, v]) => [String(k), v])),
    instructions,
    wallMs,
    peakRamMb,
    budgetExceeded,
    // diagnostics (not part of the gate, handy in CI logs):
    stdoutBytes: stdoutBytes.length,
    stderrPreview: new TextDecoder().decode(stderrBytes.subarray(0, 2000)),
  };
}

// ---------------------------------------------------------------------------
// Stack / argv / env setup — ported from nano/test/run.mjs (preserves auxv).
// ---------------------------------------------------------------------------
function setupStack(dv, memory, ramPtr, vmPtr, RAM_SIZE, argv, envObj) {
  const enc = new TextEncoder();
  const mem = new Uint8Array(memory.buffer);
  const envVars = Object.entries(envObj).map(([k, v]) => `${k}=${v}`);

  let strGuest = RAM_SIZE - 4096 - 64;
  const argGuestAddrs = [];
  for (const arg of argv) {
    const bytes = enc.encode(arg + "\0");
    argGuestAddrs.push(strGuest);
    mem.set(bytes, ramPtr + strGuest);
    strGuest += bytes.length;
  }
  const envGuestAddrs = [];
  for (const e of envVars) {
    const bytes = enc.encode(e + "\0");
    envGuestAddrs.push(strGuest);
    mem.set(bytes, ramPtr + strGuest);
    strGuest += bytes.length;
  }

  const sp = Number(dv.getBigUint64(vmPtr + OFF_SP, true));
  const auxvStart = sp + 32;
  const auxvPairs = [];
  let auxOff = auxvStart;
  for (let i = 0; i < 16; i++) {
    const atype = Number(dv.getBigUint64(ramPtr + auxOff, true));
    const aval = dv.getBigUint64(ramPtr + auxOff + 8, true);
    auxvPairs.push([atype, aval]);
    auxOff += 16;
    if (atype === 0) break;
  }

  const argc = argv.length, envc = envGuestAddrs.length;
  const stackDataSize = 8 + (argc + 1) * 8 + (envc + 1) * 8 + auxvPairs.length * 16;
  const newSp = (sp - 512 - stackDataSize) & ~0xF;
  let pos = newSp;
  dv.setBigUint64(ramPtr + pos, BigInt(argc), true); pos += 8;
  for (const a of argGuestAddrs) { dv.setBigUint64(ramPtr + pos, BigInt(a), true); pos += 8; }
  dv.setBigUint64(ramPtr + pos, 0n, true); pos += 8;
  for (const a of envGuestAddrs) { dv.setBigUint64(ramPtr + pos, BigInt(a), true); pos += 8; }
  dv.setBigUint64(ramPtr + pos, 0n, true); pos += 8;
  for (const [atype, aval] of auxvPairs) {
    dv.setBigUint64(ramPtr + pos, BigInt(atype), true); pos += 8;
    dv.setBigUint64(ramPtr + pos, aval, true); pos += 8;
  }
  dv.setBigUint64(vmPtr + OFF_SP, BigInt(newSp), true);
}

// ---------------------------------------------------------------------------
// VFS seed (subset of run.mjs's seed — the common files programs probe).
// ---------------------------------------------------------------------------
function seedFs(RAM_SIZE, RAM_MB) {
  const memfs = new MemFS();
  memfs.createDir("/bin");
  memfs.createDir("/dev");
  memfs.createFile("/dev/null", "");
  memfs.createDir("/etc");
  memfs.createFile("/etc/passwd", "root:x:0:0:root:/root:/bin/sh\n");
  memfs.createFile("/etc/group", "root:x:0:\n");
  memfs.createFile("/etc/hostname", "nanovm\n");
  memfs.createDir("/proc/self");
  memfs.createFile("/proc/cpuinfo", "processor\t: 0\nisa\t\t: rv64imafdc\nmmu\t\t: sv39\n");
  const totalPages = Math.floor(RAM_SIZE / 4096);
  const usedPages = Math.floor(totalPages * 0.3);
  memfs.createFile("/proc/self/statm", `${totalPages} ${usedPages} 0 ${Math.floor(usedPages / 2)} 0 ${Math.floor(usedPages / 2)} 0\n`);
  memfs.createFile("/proc/meminfo", `MemTotal:       ${RAM_MB * 1024} kB\nMemFree:        ${Math.floor(RAM_MB * 1024 * 0.8)} kB\n`);
  memfs.createDir("/root");
  memfs.createDir("/tmp");
  memfs.createDir("/usr");
  memfs.createDir("/usr/bin");
  memfs.createDir("/var");
  return memfs;
}

function mkParents(memfs, to) {
  const parts = to.split("/").filter(Boolean);
  let dir = "";
  for (let j = 0; j < parts.length - 1; j++) {
    dir += "/" + parts[j];
    try { memfs.createDir(dir); } catch { /* exists */ }
  }
}

function loadFixtures(memfs, load, recipeDir) {
  for (const item of load) {
    const data = readFileSync(resolve(recipeDir, item.from));
    mkParents(memfs, item.to);
    memfs.createFile(item.to, data);
  }
}

// Stage a whole directory tree into the guest FS (dir/<rel> → /<rel>), for
// multi-file apps like devenv where the entrypoint binary needs its node_modules
// tree present. Symlinks are skipped (mirrors the packager).
function loadTree(memfs, root) {
  let count = 0;
  const walk = (cur) => {
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink?.()) continue;
      if (st.isDirectory()) { walk(p); continue; }
      if (st.isFile()) {
        const to = "/" + relative(root, p);
        mkParents(memfs, to);
        memfs.createFile(to, readFileSync(p));
        count++;
      }
    }
  };
  walk(root);
  console.error(`[conformance] staged ${count} tree file(s) from ${root}`);
}

// ---------------------------------------------------------------------------
// Deterministic I/O fixtures (M1 stdin + B3 net record/replay).
// ---------------------------------------------------------------------------

// Build the seeded-stdin buffer from run.json "stdin" (a string or an array of
// string/byte chunks). Returns { buf, pos } or null when no stdin is declared.
export function buildStdin(spec) {
  if (spec == null) return null;
  const enc = new TextEncoder();
  let buf;
  if (typeof spec === "string") buf = enc.encode(spec);
  else if (Array.isArray(spec)) buf = concat(spec.map((c) => (typeof c === "string" ? enc.encode(c) : Uint8Array.from(c))));
  else return null;
  return { buf, pos: 0, scratch: 0, scratchCap: 0 };
}

// Is the current FS_PENDING a parked stdin read/ppoll (vs. a real FS request)?
function isStdinPark(X, dv, vmPtr) {
  const reqPtr = X.vm_fs_request_ptr(vmPtr);
  const sysnr = dv.getInt32(reqPtr, true);
  if (sysnr === SYS_PPOLL) return true;            // ppoll only parks for stdin
  if (sysnr !== SYS_READ) return false;
  const pfd = dv.getInt32(reqPtr + 4, true);
  if (pfd < 0 || pfd >= MAX_FDS) return false;
  return dv.getInt32(vmPtr + FD_TABLE_OFF + pfd * FD_ENTRY_SIZE, true) === FD_TYPE_STDIN;
}

// Push the next stdin chunk into the guest tty ring (via a malloc'd linear-memory
// scratch buffer), or signal EOF once drained. Always makes forward progress so a
// parked stdin op completes on the following vm_io_retry. Re-signalling EOF on
// every drained call is intentional: it guarantees a re-polling guest can't park
// forever after end-of-input.
function feedStdin(X, memory, vmPtr, sin) {
  if (sin.pos < sin.buf.length) {
    const n = Math.min(STDIN_CHUNK, sin.buf.length - sin.pos);
    if (!sin.scratch || sin.scratchCap < n) {
      sin.scratch = X.malloc(Math.max(n, STDIN_CHUNK));
      sin.scratchCap = Math.max(n, STDIN_CHUNK);
    }
    new Uint8Array(memory.buffer).set(sin.buf.subarray(sin.pos, sin.pos + n), sin.scratch);
    X.vm_stdin_push(vmPtr, sin.scratch, n);
    sin.pos += n;
  } else if (typeof X.vm_stdin_eof === "function") {
    X.vm_stdin_eof(vmPtr);
  }
}

// Build the NET record/replay state from run.json "net" (array of {url, response}).
// `response` paths resolve relative to the recipe's test/ dir (like loadFixtures).
// Returns { map, req, resp, pos } or null when no net fixtures are declared.
export function buildNetState(netSpec, testDir) {
  if (!Array.isArray(netSpec) || netSpec.length === 0) return null;
  const map = new Map();
  for (const item of netSpec) {
    if (!item || !item.url || !item.response) continue;
    map.set(String(item.url), resolve(testDir, item.response));
  }
  return { map, req: [], resp: null, pos: 0 };
}

const NET_HTTP_PREFIX = "HTTP/1.1 ";

// Turn an accumulated guest request into the bytes the guest reads back. Parses
// the request's first line ("METHOD URL ...") for the URL, looks it up in the
// fixture map (exact match, then a "*" catch-all), loads the fixture, and frames
// it as an HTTP/1.1 response. A fixture already starting with "HTTP/1.1 " is
// served verbatim; otherwise it is the raw body wrapped in a synthetic 200. An
// unmatched url yields a deterministic 404 so the golden stays stable.
export function buildNetResponse(reqBytes, net) {
  const text = new TextDecoder().decode(reqBytes);
  const sep = text.indexOf("\n\n");
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const firstLine = (head.split("\n")[0] || "").replace(/\r$/, "").trim();
  const parts = firstLine.split(/\s+/).filter(Boolean);
  let url = "";
  if (parts.length >= 2) url = parts[1];
  else if (parts.length === 1 && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(parts[0])) url = parts[0];

  let fixturePath = net.map.get(url) || net.map.get("*");
  if (!fixturePath) {
    const body = new TextEncoder().encode(`nano-net: no fixture for ${url || "(no url)"}\n`);
    return frameHttp(404, "Not Found", body);
  }
  const body = new Uint8Array(readFileSync(fixturePath));
  if (startsWithAscii(body, NET_HTTP_PREFIX)) return body; // pre-framed fixture
  return frameHttp(200, "OK", body);
}

function frameHttp(status, statusText, body) {
  const head = new TextEncoder().encode(`HTTP/1.1 ${status} ${statusText}\r\ncontent-length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

function startsWithAscii(bytes, str) {
  if (bytes.length < str.length) return false;
  for (let i = 0; i < str.length; i++) if (bytes[i] !== str.charCodeAt(i)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// FS dispatch — ported from nano/test/run.mjs processFsRequest. Returns the
// syscall number (or -38 when an unhandled syscall hit the bridge → ENOSYS).
// ---------------------------------------------------------------------------
function processFsRequest(X, dv, memory, ramPtr, vmPtr, memfs, io) {
  const reqPtr = X.vm_fs_request_ptr(vmPtr);
  const syscallNr = dv.getInt32(reqPtr, true);
  const gfd = dv.getInt32(reqPtr + 4, true);
  const arg1 = Number(dv.getBigInt64(reqPtr + 8, true));
  const arg2 = Number(dv.getBigInt64(reqPtr + 16, true));
  const bufPtr = dv.getUint32(reqPtr + 32, true);
  const bufLen = dv.getUint32(reqPtr + 36, true);

  const path = resolvePath(dv, memory, reqPtr + 40, vmPtr);
  const path2 = resolvePath(dv, memory, reqPtr + 296, vmPtr);

  const fdRead = (g) => {
    const o = vmPtr + FD_TABLE_OFF + g * FD_ENTRY_SIZE;
    return { fd_type: dv.getInt32(o, true), host_fd: dv.getInt32(o + 4, true),
             offset: Number(dv.getBigInt64(o + 8, true)), flags: dv.getInt32(o + 16, true) };
  };
  const fdWrite = (g, t, h, off, fl) => {
    const o = vmPtr + FD_TABLE_OFF + g * FD_ENTRY_SIZE;
    dv.setInt32(o, t, true); dv.setInt32(o + 4, h, true);
    dv.setBigInt64(o + 8, BigInt(off), true); dv.setInt32(o + 16, fl, true); dv.setInt32(o + 20, 0, true);
  };
  const fdClear = (g) => fdWrite(g, 0, -1, 0, 0);
  const fdAlloc = () => { for (let i = 3; i < MAX_FDS; i++) if (dv.getInt32(vmPtr + FD_TABLE_OFF + i * FD_ENTRY_SIZE, true) === FD_TYPE_NONE) return i; return -24; };
  const fdOff = (g, n) => dv.setBigInt64(vmPtr + FD_TABLE_OFF + g * FD_ENTRY_SIZE + 8, BigInt(n), true);

  // ---- NET record/replay sentinel (B3) — mirrors container's /dev/__net__ ----
  // Guest openat("/dev/__net__") gets a sentinel fd (host_fd === -98); it WRITES
  // a request ("METHOD URL\nHeader: v\n\nbody"), then READS back an HTTP/1.1
  // response replayed from the recipe's net fixtures. Request/response state is
  // kept at run level (on `io.net`) so the two-open "printf >dev; read <dev"
  // pattern works as well as a single-fd RDWR shim. Only active when run.json
  // declares "net", so non-NET recipes are completely unaffected.
  const net = io && io.net;
  if (net) {
    if (syscallNr === SYS_OPENAT && path === "/dev/__net__") {
      const ng = fdAlloc();
      if (ng >= 0) fdWrite(ng, FD_TYPE_FILE, -98, 0, 0);
      dv.setBigInt64(vmPtr + OFF_A0, BigInt(ng), true);
      dv.setInt32(vmPtr + OFF_STATUS, 0, true);
      return SYS_OPENAT;
    }
    if (gfd >= 0 && gfd < MAX_FDS && fdRead(gfd).host_fd === -98) {
      let r;
      switch (syscallNr) {
        case SYS_WRITE: {
          const count = bufLen || arg1;
          // A fresh write after a completed cycle starts a new request.
          if (net.resp !== null && net.req.length === 0) { net.resp = null; net.pos = 0; }
          net.req.push(new Uint8Array(memory.buffer, ramPtr + bufPtr, count).slice());
          r = count; break;
        }
        case SYS_READ: {
          if (net.resp === null) { net.resp = buildNetResponse(concat(net.req), net); net.req = []; net.pos = 0; }
          const want = bufLen || arg1;
          const n = Math.min(want, net.resp.length - net.pos);
          if (n > 0) {
            new Uint8Array(memory.buffer, ramPtr + bufPtr, n).set(net.resp.subarray(net.pos, net.pos + n));
            net.pos += n;
          }
          r = n; break;
        }
        case SYS_CLOSE: {
          fdClear(gfd);
          // Request written then closed without a read (printf>; read pattern):
          // build the response now so the next open+read serves it.
          if (net.req.length && net.resp === null) { net.resp = buildNetResponse(concat(net.req), net); net.req = []; net.pos = 0; }
          r = 0; break;
        }
        case SYS_FSTAT: {
          const phys = ramPtr + (arg1 >>> 0);
          new Uint8Array(memory.buffer, phys, 128).fill(0);
          const sdv = new DataView(memory.buffer, phys, 128);
          sdv.setUint32(16, 0o100644, true); sdv.setUint32(20, 1, true); sdv.setInt32(56, 4096, true);
          r = 0; break;
        }
        case SYS_LSEEK: { r = 0; break; }
        default: r = -22; break; // EINVAL for unsupported ops on the net device
      }
      dv.setBigInt64(vmPtr + OFF_A0, BigInt(r), true);
      dv.setInt32(vmPtr + OFF_STATUS, 0, true);
      return syscallNr;
    }
  }

  let result = 0;
  switch (syscallNr) {
    case SYS_OPENAT: {
      const hostFd = memfs.open(path, arg1, arg2);
      if (hostFd < 0) { result = hostFd; break; }
      const ng = fdAlloc();
      if (ng < 0) { memfs.close(hostFd); result = ng; break; }
      const entry = memfs.openFiles.get(hostFd);
      fdWrite(ng, (entry && entry.node.isDir) ? FD_TYPE_DIR : FD_TYPE_FILE, hostFd, 0, arg1);
      result = ng; break;
    }
    case SYS_CLOSE: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(gfd);
      if (fe.fd_type === FD_TYPE_NONE) { result = -9; break; }
      if (fe.fd_type === FD_TYPE_FILE || fe.fd_type === FD_TYPE_DIR) memfs.close(fe.host_fd);
      fdClear(gfd); result = 0; break;
    }
    case SYS_LSEEK: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(gfd);
      if (fe.fd_type === FD_TYPE_NONE) { result = -9; break; }
      let n;
      if (arg2 === 0) n = arg1;
      else if (arg2 === 1) n = fe.offset + arg1;
      else if (arg2 === 2) { const sz = memfs.lseekSize(fe.host_fd); n = (sz < 0 ? 0 : sz) + arg1; }
      else { result = -22; break; }
      if (n < 0) { result = -22; break; }
      fdOff(gfd, n); result = n; break;
    }
    case SYS_READ: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(gfd);
      // stdin is owned by the in-VM tty ring (try_read), so a *seeded* stdin read
      // never reaches here as a normal SYS_READ — it parks (FS_PENDING) and the
      // run loop's stdin feeder (M1) serves it. This stays the historical
      // "no live stdin" immediate-EOF for the unseeded case.
      if (fe.fd_type === FD_TYPE_STDIN) { result = 0; break; }
      if (fe.fd_type === FD_TYPE_PIPE) { result = 0; break; }
      if (fe.fd_type !== FD_TYPE_FILE && fe.fd_type !== FD_TYPE_DIR) { result = -9; break; }
      const n = memfs.pread(fe.host_fd, memory, ramPtr + bufPtr, bufLen || arg1, fe.offset);
      if (n > 0) fdOff(gfd, fe.offset + n);
      result = n; break;
    }
    case SYS_PREAD64:
    case SYS_PREADV: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(gfd);
      if (fe.fd_type !== FD_TYPE_FILE) { result = -9; break; }
      result = memfs.pread(fe.host_fd, memory, ramPtr + bufPtr, bufLen || arg1, arg2); break;
    }
    case SYS_PWRITE64:
    case SYS_PWRITEV: {                       // positional write — explicit offset, FD cursor untouched
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(gfd);
      if (fe.fd_type !== FD_TYPE_FILE) { result = -9; break; }
      result = memfs.pwrite(fe.host_fd, memory, ramPtr + bufPtr, bufLen || arg1, arg2); break;
    }
    case SYS_WRITE: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(gfd);
      if (fe.fd_type === FD_TYPE_PIPE) { result = bufLen || arg1; break; }
      if (fe.fd_type !== FD_TYPE_FILE) { result = -9; break; }
      let off = fe.offset;
      if (fe.flags & 0x400) { const sz = memfs.lseekSize(fe.host_fd); if (sz >= 0) off = sz; }
      const n = memfs.pwrite(fe.host_fd, memory, ramPtr + bufPtr, bufLen || arg1, off);
      if (n > 0) fdOff(gfd, off + n);
      result = n; break;
    }
    case SYS_GETDENTS64: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(gfd);
      if (fe.fd_type !== FD_TYPE_DIR) { result = -20; break; }
      const r = memfs.getdents(fe.host_fd, memory, ramPtr + arg1, arg2, fe.offset);
      if (typeof r === "object") { result = r.bytes; fdOff(gfd, r.nextCookie); } else result = r;
      break;
    }
    case SYS_FSTAT: {
      if (gfd < 0 || gfd >= MAX_FDS) { result = -9; break; }
      const fe = fdRead(gfd);
      const phys = ramPtr + (arg1 >>> 0);
      if (fe.fd_type >= FD_TYPE_STDIN && fe.fd_type <= FD_TYPE_STDERR) result = memfs._writeCharDevStat(memory, phys);
      else if (fe.fd_type === FD_TYPE_FILE || fe.fd_type === FD_TYPE_DIR) result = memfs.fstat(fe.host_fd, memory, phys);
      else result = -9;
      break;
    }
    case SYS_NEWFSTATAT: result = memfs.stat(path, memory, ramPtr + (arg1 >>> 0), arg2); break;
    case SYS_READLINKAT: result = memfs.readlink(path, memory, ramPtr + (arg1 >>> 0), arg2); break;
    case SYS_MKDIRAT: result = memfs.mkdir(path, arg1); break;
    case SYS_UNLINKAT: result = memfs.unlink(path, arg1); break;
    case SYS_FACCESSAT: result = memfs.access(path); break;
    case SYS_RENAMEAT2: result = memfs.rename(path, path2); break;
    case SYS_UTIMENSAT: result = 0; break;
    case SYS_STATX: result = memfs.statx(path, memory, ramPtr + (arg2 >>> 0), arg1); break;
    default: result = -38; break; // ENOSYS reaching the bridge
  }

  dv.setBigInt64(vmPtr + OFF_A0, BigInt(result), true);
  dv.setInt32(vmPtr + OFF_STATUS, 0, true);
  return syscallNr === undefined ? -38 : (result === -38 ? -38 : syscallNr);
}

function resolvePath(dv, memory, off, vmPtr) {
  const bytes = new Uint8Array(memory.buffer, off, 256);
  let e = 0; while (e < 256 && bytes[e] !== 0) e++;
  const raw = e > 0 ? new TextDecoder().decode(bytes.subarray(0, e)) : "";
  if (!raw) return readCwd(memory, vmPtr);
  if (raw.startsWith("/")) return raw;
  const cwd = readCwd(memory, vmPtr);
  return cwd === "/" ? "/" + raw : cwd + "/" + raw;
}
function readCwd(memory, vmPtr) {
  const b = new Uint8Array(memory.buffer, vmPtr + OFF_CWD, 256);
  let e = 0; while (e < 256 && b[e] !== 0) e++;
  return new TextDecoder().decode(b.subarray(0, e)) || "/";
}

function readPeakRamMb(dv, vmPtr) {
  // Best-effort: heap bytes grown via brk. Informational only (gate uses
  // instruction/wall budgets, not RAM).
  try {
    const start = dv.getBigUint64(vmPtr + OFF_BRK_START, true);
    const cur = dv.getBigUint64(vmPtr + OFF_BRK_CURRENT, true);
    const bytes = cur > start ? Number(cur - start) : 0;
    return Math.ceil(bytes / (1024 * 1024));
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
function concat(chunks) {
  let len = 0; for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
function sha256hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

// ===========================================================================
// CLI
// ===========================================================================
async function main() {
  const argv = process.argv.slice(2);
  const getOpt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  // First positional that isn't a flag or a flag's value.
  const valueFlags = new Set(["--recipe", "--report", "--merge", "--tree"]);
  let elfPath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { if (valueFlags.has(argv[i])) i++; continue; }
    elfPath = argv[i]; break;
  }
  const recipeDir = resolve(getOpt("--recipe") || ".");
  const treeDir = getOpt("--tree") ? resolve(getOpt("--tree")) : undefined;
  const reportPath = getOpt("--report");
  const mergePath = getOpt("--merge");
  const isTrace = argv.includes("--trace") || !!mergePath;

  if (!elfPath || !existsSync(elfPath)) { console.error("usage: nano-conformance.mjs <elf> --recipe <dir> [--report f | --trace --merge f]"); process.exit(2); }

  const wasmPath = process.env.NANOVM_WASM;
  if (!wasmPath || !existsSync(wasmPath)) { console.error(`NANOVM_WASM not set or missing: ${wasmPath}`); process.exit(2); }

  const runJsonPath = resolve(recipeDir, "test/run.json");
  const run = JSON.parse(readFileSync(runJsonPath, "utf8"));
  const elf = new Uint8Array(readFileSync(elfPath));

  const v = await runPass({ wasmPath, elf, run, recipeDir, treeDir });

  if (mergePath) {
    // Trace pass: keep the plain verdict authoritative for everything except the
    // syscall map, which only the trace build can produce.
    const base = JSON.parse(readFileSync(mergePath, "utf8"));
    base.syscalls = v.syscalls;
    base.traceExitCode = v.exitCode;             // sanity: should match plain run
    base.traceStdoutSha256 = v.stdoutSha256;
    writeFileSync(mergePath, JSON.stringify(base, null, 2) + "\n");
    console.error(`[conformance] merged ${Object.keys(v.syscalls).length} syscalls into ${mergePath}`);
  } else if (reportPath) {
    writeFileSync(reportPath, JSON.stringify(v, null, 2) + "\n");
    console.error(`[conformance] wrote ${reportPath} (loaded=${v.loaded} exit=${v.exitCode} faulted=${v.faulted} insns=${v.instructions})`);
  } else {
    process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
