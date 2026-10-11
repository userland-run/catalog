#!/usr/bin/env bash
# Build yq into ./out/yq as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/mikefarah/yq"
REV="v4.53.3"
SHA="1b9b4ac5187171d2e5e3129be0cfa827c7f9d53d"  # commit v4.53.3 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/yq .
cd ..
file out/yq
