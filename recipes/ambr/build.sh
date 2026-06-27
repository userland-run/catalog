#!/usr/bin/env bash
# Build ambr into ./out/ambr as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
REPO="https://github.com/dalance/amber"
REV="v0.6.1"

rustup target add riscv64gc-unknown-linux-musl
command -v cargo-zigbuild >/dev/null 2>&1 || pipx install cargo-zigbuild >/dev/null 2>&1 || cargo install cargo-zigbuild

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
cargo zigbuild --release --target riscv64gc-unknown-linux-musl --bin ambr
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/ambr out/ambr
file out/ambr
