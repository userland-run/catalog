#!/usr/bin/env bash
# Build ripgrep into ./out/rg as a static RV64GC musl ELF.
# The riscv64gc-unknown-linux-musl target links static by default.
set -euo pipefail
cd "$(dirname "$0")"

REPO="https://github.com/BurntSushi/ripgrep"
REV="14.1.0"

rustup target add riscv64gc-unknown-linux-musl

# ripgrep links jemalloc on 64-bit musl, whose build script needs a C
# cross-compiler for the target. Use zig (available in CI) as the C compiler,
# archiver and linker so jemalloc-sys and the final static link both succeed.
if command -v zig >/dev/null 2>&1; then
  export CC_riscv64gc_unknown_linux_musl="zig cc -target riscv64-linux-musl"
  export AR_riscv64gc_unknown_linux_musl="zig ar"
  export CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_LINKER="zig cc -target riscv64-linux-musl"
fi

rm -rf .src
git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
cargo build --release --target riscv64gc-unknown-linux-musl

cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/rg out/rg
file out/rg
