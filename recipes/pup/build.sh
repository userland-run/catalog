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
# pup v0.4.0 predates Go modules (GOPATH era) and ships a stale vendor/ tree, so
# `go build` fails "cannot find main module" then "inconsistent vendoring". Drop
# the old vendor dir, init a module, resolve deps fresh, and build with -mod=mod
# so the (now absent) vendor dir is ignored.
rm -rf vendor
go mod init github.com/ericchiang/pup
go mod tidy
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -mod=mod -ldflags="-s -w" -o ../out/pup .
cd ..
file out/pup
