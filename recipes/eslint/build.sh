#!/usr/bin/env bash
# Produce ./out as a guest-FS-rooted tree: ESLint installed (with deps) under
# /usr/local/lib/node_modules via a global-style npm install, plus a
# /usr/local/bin/eslint wrapper. Pure-JS, architecture-independent. Runs on `node`.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf out && mkdir -p out/usr/local

# Global install → out/usr/local/lib/node_modules/eslint + its deps (real bins).
npm install -g --prefix out/usr/local --no-fund --no-audit eslint@10.0.0

# npm makes out/usr/local/bin/eslint a symlink to the real bin; REMOVE it first
# (writing through the symlink would clobber the real eslint.js — exactly the bug
# in the old devenv tarball), then ship a plain wrapper for the catalog `node`.
mkdir -p out/usr/local/bin
rm -f out/usr/local/bin/eslint
printf '#!/bin/sh\nexec node /usr/local/lib/node_modules/eslint/bin/eslint.js "$@"\n' > out/usr/local/bin/eslint
chmod +x out/usr/local/bin/eslint

echo "eslint: $(find out -type f | wc -l | tr -d ' ') files"
