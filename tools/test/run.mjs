#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Unit tests for the catalog tooling libs — no wasm, no network, runs anywhere.
// (End-to-end conformance is exercised by the publish.yml workflow against the
// real nano runtime.)

import { generateKeyPairSync } from "node:crypto";
import { parseToml } from "../lib/toml.mjs";
import { chunk } from "../lib/fastcdc.mjs";
import { canonicalize, finalizeManifest, verifyManifest, sha256hex, loadPublicKeyRaw } from "../lib/manifest.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${msg}`); } };

// --- TOML ---
{
  const t = parseToml(`name = "ripgrep"\nversion = "14.1.0"\nabi = "x"\n\n[entrypoint]\nargv = ["rg", "--version"]\nenv = { LANG = "C" }\n`);
  ok(t.name === "ripgrep", "toml: name");
  ok(t.version === "14.1.0", "toml: version");
  ok(Array.isArray(t.entrypoint.argv) && t.entrypoint.argv[1] === "--version", "toml: argv array");
  ok(t.entrypoint.env.LANG === "C", "toml: inline table env");
}

// --- FastCDC determinism + dedup ---
{
  // Deterministic pseudo-random buffer (no Math.random — keep tests reproducible).
  const N = 5 << 20; // 5 MB
  const buf = new Uint8Array(N);
  let s = 12345 >>> 0;
  for (let i = 0; i < N; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; buf[i] = s & 0xff; }

  const a = chunk(buf);
  const b = chunk(buf);
  ok(a.length === b.length && a.every((r, i) => r.start === b[i].start && r.end === b[i].end), "fastcdc: deterministic boundaries");
  ok(a.length >= 2, "fastcdc: splits a 5MB buffer into multiple chunks");
  ok(a.every((r) => (r.end - r.start) <= (4 << 20)), "fastcdc: respects max chunk size");
  ok(a.slice(0, -1).every((r) => (r.end - r.start) >= (1 << 20)), "fastcdc: respects min chunk size (except last)");

  // Insert a byte near the end → early chunks (their content unchanged) keep the
  // same boundaries, so their sha256 dedups.
  const buf2 = new Uint8Array(N + 1);
  buf2.set(buf.subarray(0, N - 3), 0);
  buf2[N - 3] = 0xab;                    // perturbation
  buf2.set(buf.subarray(N - 3), N - 2);
  const c = chunk(buf2);
  const shaOf = (src, r) => sha256hex(Buffer.from(src.subarray(r.start, r.end)));
  const shasA = new Set(a.map((r) => shaOf(buf, r)));
  const shared = c.filter((r) => shasA.has(shaOf(buf2, r))).length;
  ok(shared >= 1, "fastcdc: shared chunks dedup across a late edit");
}

// --- canonicalize stability ---
{
  ok(canonicalize({ b: 1, a: [3, 2], c: { y: 1, x: 2 } }) === '{"a":[3,2],"b":1,"c":{"x":2,"y":1}}', "canonicalize: sorted keys, array order preserved");
}

// --- manifest sign + verify roundtrip + tamper ---
{
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPubB64 = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
  const pub = loadPublicKeyRaw(rawPubB64);

  const core = { name: "x", version: "1.0.0", files: [{ path: "/x", chunks: ["aa"] }], size: 10 };
  const { manifest } = finalizeManifest(core, privateKey);

  ok(typeof manifest.sha256 === "string" && typeof manifest.signature === "string", "manifest: has sha256 + signature");
  ok(verifyManifest(manifest, pub).ok === true, "manifest: verifies with the right key");

  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.files[0].chunks[0] = "bb";
  ok(verifyManifest(tampered, pub).ok === false, "manifest: rejects tampered content");

  const { publicKey: otherPub } = generateKeyPairSync("ed25519");
  const otherRaw = Buffer.from(otherPub.export({ format: "jwk" }).x, "base64url").toString("base64");
  ok(verifyManifest(manifest, loadPublicKeyRaw(otherRaw)).ok === false, "manifest: rejects a different key");
}

console.log(`\ncatalog lib tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
