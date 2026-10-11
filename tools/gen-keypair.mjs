#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Generate the catalog's Ed25519 signing keypair — ONE keypair per run.
//   - Private key → <private-key-file> as base64 PKCS8 DER, created with mode 0600
//     (refuses to overwrite an existing file, and refuses paths inside this repo so
//     it can never be committed by accident). Store its contents as the GitHub
//     Actions secret CATALOG_ED25519_PRIVATE_KEY, then delete the file.
//   - Public key  → keys/catalog.pub (raw 32-byte key, base64) AND printed to
//     stdout. Copy it into the SDK's sdk/src/catalog/pubkey.ts.
// The private key is never printed.
//
// Usage: node tools/gen-keypair.mjs <private-key-file>
//   e.g. node tools/gen-keypair.mjs ~/catalog-signing.key

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const out = process.argv[2];
if (!out || out.startsWith("--")) {
  console.error("usage: node tools/gen-keypair.mjs <private-key-file>   (written 0600, outside the repo)");
  process.exit(2);
}
const privPath = resolve(out);
const rel = relative(root, privPath);
if (!rel.startsWith("..") && !isAbsolute(rel)) {
  console.error(`refusing to write the private key inside the repo (${privPath}) — choose a path outside ${root}`);
  process.exit(2);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

// Raw 32-byte public key, via JWK (jwk.x is base64url of the raw key).
const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
const pubB64 = rawPub.toString("base64");

// Private key as base64 PKCS8 DER (single line, secret-friendly). `wx` = fail if
// the file exists; mode applies at creation.
const privB64 = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString("base64");
try {
  writeFileSync(privPath, privB64 + "\n", { mode: 0o600, flag: "wx" });
} catch (e) {
  console.error(`could not create ${privPath}: ${e.message} (nothing written)`);
  process.exit(1);
}

mkdirSync(resolve(root, "keys"), { recursive: true });
writeFileSync(resolve(root, "keys/catalog.pub"), pubB64 + "\n");

console.error(`wrote private key → ${privPath} (mode 0600) — store it as CATALOG_ED25519_PRIVATE_KEY, then delete it`);
console.error(`wrote keys/catalog.pub (raw Ed25519 public key, ${rawPub.length} bytes, base64)`);
process.stdout.write(pubB64 + "\n");
