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
// Usage: node tools/mirror-r2.mjs <dist>
//   env R2_BUCKET, R2_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const distDir = process.argv[2] ? resolve(process.argv[2]) : resolve("dist");
const bucket = process.env.R2_BUCKET;
const endpoint = process.env.R2_ENDPOINT;

if (!bucket) { console.error("R2_BUCKET not set — skipping R2 mirror."); process.exit(0); }
if (!endpoint) { console.error("error: R2_ENDPOINT not set"); process.exit(1); }

function s3cp(localPath, key, contentType) {
  execFileSync("aws", [
    "s3", "cp", localPath, `s3://${bucket}/${key}`,
    "--endpoint-url", endpoint,
    "--content-type", contentType,
    "--cache-control", "public, max-age=31536000, immutable",
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

// the signed index (latest assembled package)
const indexJson = resolve(distDir, "npm/index/index.json");
if (existsSync(indexJson)) s3cp(indexJson, "index.json", "application/json");

console.error(`mirrored ${n} cas blob(s) + index to R2 bucket ${bucket}`);
