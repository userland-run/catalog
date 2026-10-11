#!/usr/bin/env bash
# Build jaq into ./out/jaq as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/01mf02/jaq"
REV="v3.1.0"
SHA="ebd9d94b182fb8a38b8d8eb1e57d1319889201b9"  # commit v3.1.0 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

ensure_cargo_zigbuild

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
# add the musl target to the repo-PINNED toolchain (rust-toolchain.toml), else E0463
rustup target add riscv64gc-unknown-linux-musl
cargo zigbuild --release --locked --target riscv64gc-unknown-linux-musl -p jaq --bin jaq
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/jaq out/jaq
file out/jaq
