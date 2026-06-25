#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Generate the catalog's Ed25519 signing keypair.
//   - Public key  → keys/catalog.pub  (raw 32-byte key, base64). Committed; the
//     SDK bundles a copy and verifies every manifest/index against it.
//   - Private key → printed to stdout as base64 PKCS8 DER. Store it as the GitHub
//     Actions secret CATALOG_ED25519_PRIVATE_KEY on the catalog repo. NEVER commit it.
//
// Usage: node tools/gen-keypair.mjs            # writes keys/catalog.pub, prints private to stdout
//        node tools/gen-keypair.mjs --print    # also print the public key

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

// Raw 32-byte public key, via JWK (jwk.x is base64url of the raw key).
const jwk = publicKey.export({ format: "jwk" });
const rawPub = Buffer.from(jwk.x, "base64url");
const pubB64 = rawPub.toString("base64");

// Private key as base64 PKCS8 DER (single line, secret-friendly).
const privDer = privateKey.export({ type: "pkcs8", format: "der" });
const privB64 = Buffer.from(privDer).toString("base64");

mkdirSync(resolve(root, "keys"), { recursive: true });
writeFileSync(resolve(root, "keys/catalog.pub"), pubB64 + "\n");

console.error(`wrote keys/catalog.pub (raw Ed25519 public key, ${rawPub.length} bytes, base64)`);
if (process.argv.includes("--print")) console.error(`public (base64): ${pubB64}`);
console.error("\nStore the line below as the GitHub secret CATALOG_ED25519_PRIVATE_KEY (do NOT commit):");
process.stdout.write(privB64 + "\n");
