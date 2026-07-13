#!/usr/bin/env bash
# Build photon into ./out/photon as a wasm32-wasip1 module.
#
# Source lives in the nano repo at apps/core/build/photon (a standalone bin crate
# on the pure-Rust `image` crate — no wasm-bindgen, no threads). We clone nano at
# the pinned rev, build the crate for wasm32-wasip1, and copy the module out.
set -euo pipefail
cd "$(dirname "$0")"

REPO="https://github.com/userland-run/nano"
REV="${PHOTON_REV:-main}"

rustup target add wasm32-wasip1 >/dev/null 2>&1 || true

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src/apps/core/build/photon

cargo build --release --target wasm32-wasip1

mkdir -p ../../../../../out
cp target/wasm32-wasip1/release/photon.wasm ../../../../../out/photon

cd "$(dirname "$0")" 2>/dev/null || true
echo "built out/photon ($(wc -c < ./out/photon 2>/dev/null || echo '?') bytes)"
