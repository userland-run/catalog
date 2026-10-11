#!/usr/bin/env bash
# Build ambr into ./out/ambr as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/dalance/amber"
REV="v0.6.1"
SHA="3a48d1c42b49093278faed742063bf26c47d5fdd"  # commit v0.6.1 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

ensure_cargo_zigbuild

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
# add the musl target to the repo-PINNED toolchain (rust-toolchain.toml), else E0463
rustup target add riscv64gc-unknown-linux-musl
cargo zigbuild --release --locked --target riscv64gc-unknown-linux-musl --bin ambr
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/ambr out/ambr
file out/ambr
