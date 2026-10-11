#!/usr/bin/env bash
# Build hexyl into ./out/hexyl as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/sharkdp/hexyl"
REV="v0.14.0"
SHA="7a9234c182b19070f8707468c572b5a0e6e704d4"  # commit v0.14.0 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

ensure_cargo_zigbuild

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
# add the musl target to the repo-PINNED toolchain (rust-toolchain.toml), else E0463
rustup target add riscv64gc-unknown-linux-musl
cargo zigbuild --release --locked --target riscv64gc-unknown-linux-musl
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/hexyl out/hexyl
file out/hexyl
