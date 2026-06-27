#!/usr/bin/env bash
# Build frawk into ./out/frawk as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
REPO="https://github.com/ezrosent/frawk"
REV="v0.4.7"

command -v cargo-zigbuild >/dev/null 2>&1 || pipx install cargo-zigbuild >/dev/null 2>&1 || cargo install cargo-zigbuild

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
rustup target add riscv64gc-unknown-linux-musl
# frawk's default features pull in jemalloc (C — its build.rs trips up `zig cc`)
# and llvm-sys (needs host LLVM libs); neither cross-compiles here. Drop them with
# --no-default-features, which leaves the pure-Rust Cranelift backend + the system
# allocator. (`--version` short-circuits before any JIT, so capture stays clean.)
cargo zigbuild --release --target riscv64gc-unknown-linux-musl --bin frawk --no-default-features
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/frawk out/frawk
file out/frawk
