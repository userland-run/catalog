#!/usr/bin/env bash
# Produce ./out as a guest-FS-rooted tree: Prettier installed under
# /usr/local/lib/node_modules via a global-style npm install, plus a
# /usr/local/bin/prettier wrapper. Pure-JS, architecture-independent. Runs on `node`.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf out && mkdir -p out/usr/local

npm install -g --prefix out/usr/local --no-fund --no-audit prettier@3.8.1

# Remove npm's bin symlink before writing the wrapper (writing through it would
# clobber the real prettier.cjs), then ship a plain wrapper for the catalog `node`.
mkdir -p out/usr/local/bin
rm -f out/usr/local/bin/prettier
printf '#!/bin/sh\nexec node /usr/local/lib/node_modules/prettier/bin/prettier.cjs "$@"\n' > out/usr/local/bin/prettier
chmod +x out/usr/local/bin/prettier

echo "prettier: $(find out -type f | wc -l | tr -d ' ') files"
