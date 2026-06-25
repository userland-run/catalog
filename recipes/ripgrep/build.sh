#!/usr/bin/env bash
# Build ripgrep into ./out/rg as a static RV64GC musl ELF.
# The riscv64gc-unknown-linux-musl target links static by default.
set -euo pipefail
cd "$(dirname "$0")"

REPO="https://github.com/BurntSushi/ripgrep"
REV="14.1.0"

rustup target add riscv64gc-unknown-linux-musl

rm -rf .src
git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
cargo build --release --target riscv64gc-unknown-linux-musl

cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/rg out/rg
file out/rg
