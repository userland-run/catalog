#!/usr/bin/env bash
# Build htmlq into ./out/htmlq as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/mgdm/htmlq"
REV="v0.4.0"
SHA="1361c8c46811dd7b961c3fe9c6b04f9318a345e8"  # commit v0.4.0 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

ensure_cargo_zigbuild

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
rustup target add riscv64gc-unknown-linux-musl
# Cargo.lock pins libc 0.2.101 (2021), which predates riscv64-musl support and
# fails to compile against it (707 errors: cannot find type `c_char`/`__u64`…).
# Bump just libc to a riscv64-aware 0.2.x; the rest of the (old) lockfile stays put.
# --precise pins the bump (0.2.186 = newest 0.2.x when this recipe was last
# built) so the lockfile stays reproducible; the build below is then --locked.
cargo update -p libc --precise 0.2.186
cargo zigbuild --release --locked --target riscv64gc-unknown-linux-musl
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/htmlq out/htmlq
file out/htmlq
