#!/usr/bin/env bash
# Build gojq into ./out/gojq as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
REPO="https://github.com/itchyny/gojq"
REV="v0.12.19"

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/gojq ./cmd/gojq
cd ..
file out/gojq
