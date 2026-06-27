#!/usr/bin/env bash
# Build goawk into ./out/goawk as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
REPO="https://github.com/benhoyt/goawk"
REV="v1.31.0"

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/goawk .
cd ..
file out/goawk
