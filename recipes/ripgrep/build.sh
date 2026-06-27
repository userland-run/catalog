#!/usr/bin/env bash
# Build ripgrep into ./out/rg as a static RV64GC musl ELF via cargo-zigbuild
# (drives the build through zig + handles the musl/libgcc_s quirks).
set -euo pipefail
cd "$(dirname "$0")"
REPO="https://github.com/BurntSushi/ripgrep"
REV="14.1.0"

rustup target add riscv64gc-unknown-linux-musl
command -v cargo-zigbuild >/dev/null 2>&1 || pipx install cargo-zigbuild >/dev/null 2>&1 || cargo install cargo-zigbuild

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
cargo zigbuild --release --target riscv64gc-unknown-linux-musl
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/rg out/rg
file out/rg
