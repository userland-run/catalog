#!/usr/bin/env bash
# Build b3sum into ./out/b3sum as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
REPO="https://github.com/BLAKE3-team/BLAKE3"
REV="1.8.5"

command -v cargo-zigbuild >/dev/null 2>&1 || pipx install cargo-zigbuild >/dev/null 2>&1 || cargo install cargo-zigbuild

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
rustup target add riscv64gc-unknown-linux-musl
# b3sum is a standalone crate under b3sum/ — NOT a member of the root blake3
# package (the repo has no cargo workspace), so `-p b3sum` from the root fails
# "package ID specification `b3sum` did not match any packages". Build inside its
# own directory; it pulls in the parent blake3 via a `path = ".."` dependency.
cd b3sum
cargo zigbuild --release --target riscv64gc-unknown-linux-musl --bin b3sum
cd ../..
mkdir -p out
cp .src/b3sum/target/riscv64gc-unknown-linux-musl/release/b3sum out/b3sum
file out/b3sum
