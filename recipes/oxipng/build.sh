#!/usr/bin/env bash
# Build oxipng into ./out/oxipng as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
REPO="https://github.com/shssoichiro/oxipng"
REV="v10.1.1"

command -v cargo-zigbuild >/dev/null 2>&1 || pipx install cargo-zigbuild >/dev/null 2>&1 || cargo install cargo-zigbuild

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
# add the musl target to the repo-PINNED toolchain (rust-toolchain.toml), else E0463
rustup target add riscv64gc-unknown-linux-musl
cargo zigbuild --release --target riscv64gc-unknown-linux-musl
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/oxipng out/oxipng
file out/oxipng
