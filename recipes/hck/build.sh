#!/usr/bin/env bash
# Build hck into ./out/hck as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/sstadick/hck"
REV="v0.11.6"
SHA="e343425ecd8bada3a423139c305563a8d408c303"  # commit v0.11.6 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

ensure_cargo_zigbuild

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
# The repo pins an exact toolchain (rust-toolchain.toml, profile=minimal). cargo
# auto-installs THAT toolchain fresh, WITHOUT the riscv64-musl std, so a plain
# `rustup target add` (which lands on stable) never applies → E0463 "can't find
# crate for core". Drop the pin so the build runs on CI's stable, which already
# carries the riscv64gc-unknown-linux-musl std.
rm -f rust-toolchain.toml rust-toolchain
rustup target add riscv64gc-unknown-linux-musl
cargo zigbuild --release --locked --target riscv64gc-unknown-linux-musl --bin hck
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/hck out/hck
file out/hck
