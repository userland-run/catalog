#!/usr/bin/env bash
# Produce ./out as a guest-FS-rooted tree: TypeScript installed under
# /usr/local/lib/node_modules via a global-style npm install, plus a
# /usr/local/bin/tsc wrapper. Pure-JS, architecture-independent. Runs on `node`.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf out && mkdir -p out/usr/local

npm install -g --prefix out/usr/local --no-fund --no-audit typescript@5.9.3

# npm makes the /usr/local/bin/* entries symlinks to the real bins; REMOVE them
# first (writing through a symlink would clobber the real JS), then ship a plain
# wrapper for the catalog `node`.
mkdir -p out/usr/local/bin
rm -f out/usr/local/bin/tsc out/usr/local/bin/tsserver
printf '#!/bin/sh\nexec node /usr/local/lib/node_modules/typescript/lib/tsc.js "$@"\n' > out/usr/local/bin/tsc
chmod +x out/usr/local/bin/tsc

echo "typescript: $(find out -type f | wc -l | tr -d ' ') files"
