#!/usr/bin/env bash
# Build gix (the gitoxide CLI) into ./out/gix as a static RV64GC musl ELF via
# cargo-zigbuild — it drives the build through zig (bundles musl + a C cross-
# compiler) and handles the musl/libgcc_s quirks a raw "cargo build + zig linker"
# trips over.
#
# gitoxide is pure Rust. The `gix` binary lives in the *root* workspace package
# `gitoxide` (default-run = "gix"; the package also builds an `ein` bin we skip).
# We force `--no-default-features --features max-pure` instead of the default
# `max`: `max` pulls in `http-client-curl-openssl` (curl + OpenSSL C deps), while
# `max-pure` is the upstream-recommended pure-Rust build — zlib-rs for full-speed
# zlib and reqwest+rustls for HTTPS, so there is NO C toolchain dependency and it
# links cleanly static.
#
# Capability note: LOCAL git (gix init/add/commit/log/status, and reading any
# on-disk repo) is filesystem-only and works fully OFFLINE inside nano. REMOTE git
# (gix clone/fetch over HTTPS) additionally needs the nano network bridge + a CORS
# proxy (Tier 1.5) — that wiring is a follow-up; the binary itself already carries
# the pure-Rust HTTPS transport for when the bridge lands.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/GitoxideLabs/gitoxide"
REV="v0.55.0"
SHA="6428edc82fc8a16d5ef34ca2d49aa6fdff3645fe"  # commit v0.55.0 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

ensure_cargo_zigbuild

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
# add the musl target to the repo-PINNED toolchain (rust-toolchain.toml), else E0463
rustup target add riscv64gc-unknown-linux-musl
cargo zigbuild --release --locked --target riscv64gc-unknown-linux-musl \
  -p gitoxide --bin gix --no-default-features --features max-pure
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/gix out/gix
file out/gix
