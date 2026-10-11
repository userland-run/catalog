#!/usr/bin/env bash
# Build resvg into ./out/resvg as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/linebender/resvg"
REV="v0.47.0"
SHA="3a0fdba53ccf2d346b54cc53ba7adf0ee60d0707"  # commit v0.47.0 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

ensure_cargo_zigbuild

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
# add the musl target to the repo-PINNED toolchain (rust-toolchain.toml), else E0463
rustup target add riscv64gc-unknown-linux-musl
cargo zigbuild --release --locked --target riscv64gc-unknown-linux-musl -p resvg --bin resvg
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/resvg out/resvg
file out/resvg
