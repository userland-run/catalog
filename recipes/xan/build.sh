#!/usr/bin/env bash
# Build xan into ./out/xan as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
REPO="https://github.com/medialab/xan"
REV="0.59.0"

command -v cargo-zigbuild >/dev/null 2>&1 || pipx install cargo-zigbuild >/dev/null 2>&1 || cargo install cargo-zigbuild

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
# The repo pins an exact toolchain (rust-toolchain.toml, profile=minimal). cargo
# auto-installs THAT toolchain fresh, WITHOUT the riscv64-musl std, so a plain
# `rustup target add` (which lands on stable) never applies → E0463 "can't find
# crate for core". Drop the pin so the build runs on CI's stable, which already
# carries the riscv64gc-unknown-linux-musl std.
rm -f rust-toolchain.toml rust-toolchain
rustup target add riscv64gc-unknown-linux-musl
cargo zigbuild --release --target riscv64gc-unknown-linux-musl --bin xan
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/xan out/xan
file out/xan
