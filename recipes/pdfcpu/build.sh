#!/usr/bin/env bash
# Build the pdfcpu CLI into ./out/pdfcpu as a wasm32-wasip1 module (Go's
# GOOS=wasip1 GOARCH=wasm port; pure Go, CGO off). Needs Go >= 1.26 (pdfcpu's go.mod).
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned (supply-chain pin)
REPO="https://github.com/pdfcpu/pdfcpu"
REV="v0.16.1"
SHA="2f7a89a0a69c117a5252601907ff9f31ac4c70f2"  # commit v0.16.1 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

clone_pinned "$REPO" "$REV" "$SHA" .src
mkdir -p out
# Module downloads are verified against go.sum (GOFLAGS=-mod=readonly keeps go.mod/go.sum fixed).
(cd .src && GOFLAGS=-mod=readonly GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w" -o ../out/pdfcpu ./cmd/pdfcpu)
echo "built out/pdfcpu ($(wc -c < out/pdfcpu) bytes)"
