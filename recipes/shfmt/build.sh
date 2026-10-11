#!/usr/bin/env bash
# Build shfmt into ./out/shfmt as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/mvdan/sh"
REV="v3.13.1"
SHA="2f3f5e36d9b0f8f14c998d50aa20a28832205ae8"  # commit v3.13.1 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/shfmt ./cmd/shfmt
cd ..
file out/shfmt
