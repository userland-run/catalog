#!/usr/bin/env bash
# Build dyff into ./out/dyff as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/homeport/dyff"
REV="v1.12.0"
SHA="ea5d770b575967f1bc21eefcae08712d8f755e04"  # commit v1.12.0 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/dyff ./cmd/dyff
cd ..
file out/dyff
