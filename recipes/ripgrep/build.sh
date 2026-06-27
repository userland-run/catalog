#!/usr/bin/env bash
# Build ripgrep into ./out/rg as a static RV64GC musl ELF.
# The riscv64gc-unknown-linux-musl target links static by default.
set -euo pipefail
cd "$(dirname "$0")"

REPO="https://github.com/BurntSushi/ripgrep"
REV="14.1.0"

rustup target add riscv64gc-unknown-linux-musl

# ripgrep links jemalloc on 64-bit musl, whose build script needs a C
# cross-compiler for the target. Use zig as the C compiler, archiver and linker.
# cargo's *_LINKER env must be a single executable (no args), so wrap zig.
if command -v zig >/dev/null 2>&1; then
  ZW="$(mktemp -d)"
  printf '#!/bin/sh\nexec zig cc -target riscv64-linux-musl "$@"\n' > "$ZW/zcc"; chmod +x "$ZW/zcc"
  printf '#!/bin/sh\nexec zig ar "$@"\n' > "$ZW/zar"; chmod +x "$ZW/zar"
  export CC_riscv64gc_unknown_linux_musl="$ZW/zcc"
  export AR_riscv64gc_unknown_linux_musl="$ZW/zar"
  export CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_LINKER="$ZW/zcc"
fi

rm -rf .src
git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
cargo build --release --target riscv64gc-unknown-linux-musl

cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/rg out/rg
file out/rg
