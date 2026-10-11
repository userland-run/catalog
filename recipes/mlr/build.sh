#!/usr/bin/env bash
# Build mlr into ./out/mlr as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/johnkerl/miller"
REV="v6.19.0"
SHA="0c675ee6da2c8df66ce1996e36aa0bc60487c463"  # commit v6.19.0 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/mlr ./cmd/mlr
cd ..
file out/mlr
