#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Key-sync guard: keys/catalog.pub (what publish.mjs signs for) must equal the
// CATALOG_PUBLIC_KEY_B64 the SDK pins in sdk/src/catalog/pubkey.ts (what every
// client verifies against). A mismatch means every published manifest would be
// rejected by clients — or the SDK trusts a key we no longer control.
//
// Usage: node tools/check-pubkey.mjs [path/to/pubkey.ts] [--require]
//   default path: ../sdk/src/catalog/pubkey.ts (sibling checkout). Without
//   --require a missing SDK checkout is a skip (exit 0); CI passes --require.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublicKeyRaw } from "./lib/manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const require_ = args.includes("--require");
const tsPath = resolve(args.find((a) => !a.startsWith("--")) || resolve(root, "../sdk/src/catalog/pubkey.ts"));

const pub = readFileSync(resolve(root, "keys/catalog.pub"), "utf8").trim();
loadPublicKeyRaw(pub); // throws unless a valid 32-byte Ed25519 key

if (!existsSync(tsPath)) {
  const msg = `SDK pubkey file not found: ${tsPath}`;
  if (require_) { console.error(`error: ${msg}`); process.exit(1); }
  console.error(`skip: ${msg}`); process.exit(0);
}
const m = /CATALOG_PUBLIC_KEY_B64\s*(?::\s*string\s*)?=\s*["']([A-Za-z0-9+/=]+)["']/.exec(readFileSync(tsPath, "utf8"));
if (!m) { console.error(`error: no CATALOG_PUBLIC_KEY_B64 literal in ${tsPath}`); process.exit(1); }
if (m[1] !== pub) {
  console.error(`error: key mismatch\n  keys/catalog.pub        ${pub}\n  ${tsPath}  ${m[1]}`);
  process.exit(1);
}
console.log(`OK: keys/catalog.pub matches the SDK's pinned key (${pub})`);
