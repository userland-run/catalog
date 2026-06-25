// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Canonical JSON + Ed25519 signing/verification shared by package.mjs (sign) and
// publish.mjs / verify-manifest.mjs (verify). The same canonicalization must be
// used by the SDK client so signatures verify on both sides.

import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

// Deterministic JSON: object keys sorted recursively, no insignificant whitespace.
// Arrays keep order. This is what we hash and sign.
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

export function sha256hex(bytesOrString) {
  return createHash("sha256").update(bytesOrString).digest("hex");
}

// Load an Ed25519 private key from base64 PKCS8 DER or a PEM string (env-friendly).
export function loadPrivateKey(secret) {
  const s = secret.trim();
  if (s.includes("BEGIN ")) return createPrivateKey(s); // PEM
  return createPrivateKey({ key: Buffer.from(s, "base64"), format: "der", type: "pkcs8" });
}

// Load an Ed25519 public key from a raw 32-byte base64 key (keys/catalog.pub).
export function loadPublicKeyRaw(rawB64) {
  const raw = Buffer.from(rawB64.trim(), "base64");
  // SPKI DER prefix for Ed25519, then the 32 raw bytes.
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

export function signEd25519(privateKey, messageBytes) {
  // For Ed25519 the algorithm arg must be null.
  return edSign(null, Buffer.from(messageBytes), privateKey).toString("base64");
}

export function verifyEd25519(publicKey, messageBytes, signatureB64) {
  return edVerify(null, Buffer.from(messageBytes), publicKey, Buffer.from(signatureB64, "base64"));
}

// Build the signed manifest bytes from a manifest object that has NEITHER sha256
// NOR signature yet. Returns { manifest, bytes } where bytes is the exact signed
// JSON (its sha256 is the manifest's content address in cas/).
//   sha256    = sha256( canonical(manifest without sha256, signature) )
//   signature = ed25519( canonical(manifest without signature) )   // includes sha256
export function finalizeManifest(manifestCore, privateKey) {
  const base = { ...manifestCore };
  delete base.sha256;
  delete base.signature;
  const contentHash = sha256hex(canonicalize(base));
  const withHash = { ...base, sha256: contentHash };
  const signature = signEd25519(privateKey, canonicalize(withHash));
  const manifest = { ...withHash, signature };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { manifest, bytes };
}

// Verify a parsed manifest object against a public key. Returns {ok, reason}.
export function verifyManifest(manifest, publicKey) {
  const { signature, sha256, ...rest } = manifest;
  if (!signature) return { ok: false, reason: "missing signature" };
  if (!sha256) return { ok: false, reason: "missing sha256" };
  if (sha256hex(canonicalize(rest)) !== sha256) return { ok: false, reason: "sha256 mismatch" };
  const withHash = { ...rest, sha256 };
  if (!verifyEd25519(publicKey, canonicalize(withHash), signature)) return { ok: false, reason: "bad signature" };
  return { ok: true };
}
