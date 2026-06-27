#!/usr/bin/env bash
# Build nfetch into ./out/nfetch as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
#
# nfetch is a single self-contained, std-only src/main.rs (no dependencies), so
# there is no upstream repo to clone: we synthesize a throwaway Cargo crate in
# .build/ (gitignored) that points cargo at our source, then cross-compile.
set -euo pipefail
cd "$(dirname "$0")"

command -v cargo-zigbuild >/dev/null 2>&1 || pipx install cargo-zigbuild >/dev/null 2>&1 || cargo install cargo-zigbuild

# Synthesize a minimal crate around our single source file.
rm -rf .build && mkdir -p .build/src
cp src/main.rs .build/src/main.rs
cat > .build/Cargo.toml <<'EOF'
[package]
name = "nfetch"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "nfetch"
path = "src/main.rs"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
strip = true
panic = "abort"
EOF

cd .build
cargo zigbuild --release --target riscv64gc-unknown-linux-musl
cd ..

mkdir -p out
cp .build/target/riscv64gc-unknown-linux-musl/release/nfetch out/nfetch
file out/nfetch
