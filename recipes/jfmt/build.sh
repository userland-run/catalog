#!/usr/bin/env bash
# Stage jfmt into ./out/jfmt — a single self-contained JS file (no build step,
# no dependencies). The node runner executes it on the host Node engine.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
cp src/jfmt.js out/jfmt
chmod +x out/jfmt
echo "staged out/jfmt ($(wc -c < out/jfmt) bytes)"
