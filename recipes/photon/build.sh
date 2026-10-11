#!/usr/bin/env bash
# Build photon into ./out/photon as a wasm32-wasip1 module.
#
# Source lives in the nano repo at apps/core/build/photon (a standalone bin crate
# on the pure-Rust `image` crate — no wasm-bindgen, no threads). We clone nano at
# the pinned rev, build the crate for wasm32-wasip1, and copy the module out.
#
# Toolchain: the nano repo root pins `rust-toolchain.toml` (channel = nightly,
# targets = wasm32-unknown-unknown). Inside the clone, a bare `cargo`/`rustup`
# therefore resolves to an auto-installed nightly WITHOUT the wasip1 std →
# E0463 "can't find crate for `core`" (the CI failure). The crate builds on
# stable, so build with the explicit `+stable` toolchain (CI installs the
# wasm32-wasip1 target on stable; we add it here too, idempotently).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

REPO="https://github.com/userland-run/nano"
REV="${PHOTON_REV:-main}"

rustup target add --toolchain stable wasm32-wasip1

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src/apps/core/build/photon

cargo +stable build --release --target wasm32-wasip1

mkdir -p "$HERE/out"
cp target/wasm32-wasip1/release/photon.wasm "$HERE/out/photon"
echo "built out/photon ($(wc -c < "$HERE/out/photon") bytes)"
