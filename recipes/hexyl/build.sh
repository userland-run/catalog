#!/usr/bin/env bash
# Build hexyl into ./out/hexyl as a static RV64GC musl ELF. The
# riscv64gc-unknown-linux-musl target links static by default; zig provides the
# C cross-compiler that crates with C deps (jemalloc, ring, …) need.
set -euo pipefail
cd "$(dirname "$0")"
REPO="https://github.com/sharkdp/hexyl"
REV="v0.14.0"

rustup target add riscv64gc-unknown-linux-musl
if command -v zig >/dev/null 2>&1; then
  export CC_riscv64gc_unknown_linux_musl="zig cc -target riscv64-linux-musl"
  export AR_riscv64gc_unknown_linux_musl="zig ar"
  export CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_LINKER="zig cc -target riscv64-linux-musl"
fi

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
cargo build --release --target riscv64gc-unknown-linux-musl
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/hexyl out/hexyl
file out/hexyl
