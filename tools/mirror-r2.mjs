#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Optional fallback mirror (spec §7.3): push the content-addressed cas blobs and
// the signed index to a Cloudflare R2 bucket (S3-compatible, zero egress) behind
// Cloudflare's CDN. The client logic is identical because every object is
// content-addressed and signature-verified, so the origin is interchangeable and
// untrusted. Use this for artifacts beyond jsDelivr's per-package ceiling.
//
// Uploads via the `aws` CLI (S3 API) so no SDK dependency is needed. Skips
// cleanly unless R2_BUCKET is set.
//
// Layout + caching:
//   cas/<sha256>          immutable (content-addressed)        max-age=1y, immutable
//   index/<gen>.json      immutable (one per generation)       max-age=1y, immutable
//   index.json            MUTABLE pointer to the newest gen    max-age=60
// Upload order is cas → index/<gen>.json → index.json, so the pointer never
// names blobs that are not yet in the bucket. The pointer is short-cached so a
// new generation propagates in about a minute instead of being pinned for a year.
//
// Usage: node tools/mirror-r2.mjs <dist>
//   env R2_BUCKET, R2_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const distDir = process.argv[2] ? resolve(process.argv[2]) : resolve("dist");
const bucket = process.env.R2_BUCKET;
const endpoint = process.env.R2_ENDPOINT;

if (!bucket) { console.error("R2_BUCKET not set — skipping R2 mirror."); process.exit(0); }
if (!endpoint) { console.error("error: R2_ENDPOINT not set"); process.exit(1); }

const IMMUTABLE = "public, max-age=31536000, immutable";
const POINTER = "public, max-age=60, must-revalidate";

function s3cp(localPath, key, contentType, cacheControl = IMMUTABLE) {
  execFileSync("aws", [
    "s3", "cp", localPath, `s3://${bucket}/${key}`,
    "--endpoint-url", endpoint,
    "--content-type", contentType,
    "--cache-control", cacheControl,
  ], { stdio: "inherit" });
}

// cas blobs (immutable, content-addressed)
const casDir = resolve(distDir, "cas");
let n = 0;
for (const sha of existsSync(casDir) ? readdirSync(casDir) : []) {
  if (sha.startsWith(".")) continue;
  s3cp(resolve(casDir, sha), `cas/${sha}`, "application/octet-stream");
  n++;
}

// the signed index (latest assembled package): immutable per-generation copy
// first, then the short-cached mutable pointer.
const indexJson = resolve(distDir, "npm/index/index.json");
if (!existsSync(indexJson)) { console.error(`error: ${indexJson} not found — run publish.mjs first`); process.exit(1); }
const gen = JSON.parse(readFileSync(indexJson, "utf8")).generation;
if (!Number.isSafeInteger(gen) || gen < 1) { console.error(`error: index.json has no valid generation (${gen})`); process.exit(1); }
s3cp(indexJson, `index/${gen}.json`, "application/json");
s3cp(indexJson, "index.json", "application/json", POINTER);

console.error(`mirrored ${n} cas blob(s) + index generation ${gen} (index/${gen}.json + index.json pointer) to R2 bucket ${bucket}`);
