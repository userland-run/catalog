#!/usr/bin/env bash
# Build difft into ./out/difft as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/Wilfred/difftastic"
REV="0.69.0"
SHA="90a0f1b6aa88401170405a87be139cbabe00b12a"  # commit 0.69.0 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

ensure_cargo_zigbuild

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
# The repo pins an exact toolchain (rust-toolchain.toml, profile=minimal). cargo
# auto-installs THAT toolchain fresh, WITHOUT the riscv64-musl std, so a plain
# `rustup target add` (which lands on stable) never applies → E0463 "can't find
# crate for core". Drop the pin so the build runs on CI's stable, which already
# carries the riscv64gc-unknown-linux-musl std.
rm -f rust-toolchain.toml rust-toolchain
rustup target add riscv64gc-unknown-linux-musl
# jemalloc-sys links libatomic on riscv64, which zig/musl don't provide as a
# standalone -latomic, so the final link fails. jemalloc is only a perf tweak;
# exclude it on riscv64 (extend its cfg) so difftastic uses the system allocator
# and the -latomic dependency disappears.
sed -i 's/target_os = "freebsd")))/target_os = "freebsd", target_arch = "riscv64")))/g' Cargo.toml src/main.rs
cargo zigbuild --release --locked --target riscv64gc-unknown-linux-musl --bin difft
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/difft out/difft
file out/difft
