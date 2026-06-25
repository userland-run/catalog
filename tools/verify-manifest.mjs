#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Verify a signed manifest or index against keys/catalog.pub. This is the same
// check the SDK client performs before trusting any CDN bytes — exposed as a CLI
// for local inspection and CI smoke tests.
//
// Usage: node tools/verify-manifest.mjs <manifest-or-index.json> [keys/catalog.pub]

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyManifest, loadPublicKeyRaw } from "./lib/manifest.mjs";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolsDir, "..");

const file = process.argv[2];
const pubPath = process.argv[3] || resolve(root, "keys/catalog.pub");
if (!file || !existsSync(file)) { console.error("usage: verify-manifest.mjs <json> [catalog.pub]"); process.exit(2); }
if (!existsSync(pubPath)) { console.error(`public key not found: ${pubPath}`); process.exit(2); }

const obj = JSON.parse(readFileSync(file, "utf8"));
const publicKey = loadPublicKeyRaw(readFileSync(pubPath, "utf8"));

const { ok, reason } = verifyManifest(obj, publicKey);
if (ok) { console.log(`OK: signature + content hash valid (${obj.name ? `${obj.name}@${obj.version}` : `index gen ${obj.generation}`})`); process.exit(0); }
console.error(`INVALID: ${reason}`);
process.exit(1);
