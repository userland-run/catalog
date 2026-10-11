#!/usr/bin/env bash
# Build dasel into ./out/dasel as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/TomWright/dasel"
REV="v3.11.1"
SHA="5d609b8982d4f23a12f40e5d47009ba2a1bda218"  # commit v3.11.1 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/dasel ./cmd/dasel
cd ..
file out/dasel
