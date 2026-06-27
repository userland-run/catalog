#!/usr/bin/env bash
# Build htmlq into ./out/htmlq as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
REPO="https://github.com/mgdm/htmlq"
REV="v0.4.0"

command -v cargo-zigbuild >/dev/null 2>&1 || pipx install cargo-zigbuild >/dev/null 2>&1 || cargo install cargo-zigbuild

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
rustup target add riscv64gc-unknown-linux-musl
# Cargo.lock pins libc 0.2.101 (2021), which predates riscv64-musl support and
# fails to compile against it (707 errors: cannot find type `c_char`/`__u64`…).
# Bump just libc to a riscv64-aware 0.2.x; the rest of the (old) lockfile stays put.
cargo update -p libc
cargo zigbuild --release --target riscv64gc-unknown-linux-musl
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/htmlq out/htmlq
file out/htmlq
