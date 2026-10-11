#!/usr/bin/env bash
# Build glow into ./out/glow as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/charmbracelet/glow"
REV="v2.1.2"
SHA="f57087499b407d420cdad1d76d0e1ed33c77a3d8"  # commit v2.1.2 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/glow .
cd ..
file out/glow
