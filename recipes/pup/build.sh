#!/usr/bin/env bash
# Build pup into ./out/pup as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
REPO="https://github.com/ericchiang/pup"
REV="v0.4.0"

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/pup .
cd ..
file out/pup
