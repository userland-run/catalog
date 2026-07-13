#!/usr/bin/env bash
# Stage calc into ./out/calc — a single self-contained JS file (no build step).
# The boa runner loads and evaluates it in the Boa sandbox.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
cp src/calc.js out/calc
echo "staged out/calc ($(wc -c < out/calc) bytes)"
