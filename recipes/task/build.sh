#!/usr/bin/env bash
# Build task into ./out/task as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/go-task/task"
REV="v3.51.1"
SHA="bd79c29a39b1fc4a7cdd0ef9f2c3cd2f06886e2a"  # commit v3.51.1 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/task ./cmd/task
cd ..
file out/task
