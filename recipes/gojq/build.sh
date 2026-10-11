#!/usr/bin/env bash
# Build gojq into ./out/gojq as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/itchyny/gojq"
REV="v0.12.19"
SHA="b7ebffbfc038677520df0bae4c8c2d877f88ffea"  # commit v0.12.19 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/gojq ./cmd/gojq
cd ..
file out/gojq
