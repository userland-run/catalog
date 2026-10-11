#!/usr/bin/env bash
# Build ripgrep into ./out/rg as a static RV64GC musl ELF via cargo-zigbuild
# (drives the build through zig + handles the musl/libgcc_s quirks).
#
# Why the source patch below: on 64-bit musl, ripgrep force-selects jemalloc as
# its #[global_allocator] via a CODE-LEVEL cfg in crates/core/main.rs plus a
# target-specific Cargo dependency. This is NOT a cargo feature, so
# --no-default-features cannot drop it. jemalloc-sys's autotools ./configure then
# dies under the zig cross-compiler ("C compiler cannot create executables").
# We strip jemalloc out of the source so ripgrep falls back to the default
# (system/musl) allocator — correctness is unaffected, only allocator perf.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
REPO="https://github.com/BurntSushi/ripgrep"
REV="14.1.0"
SHA="e50df40a1967708b9781486b1c017e48040bceb0"  # commit 14.1.0 must resolve to; re-pin: git ls-remote $REPO "refs/tags/$REV^{}"

ensure_cargo_zigbuild

clone_pinned "$REPO" "$REV" "$SHA" .src
cd .src
# The Cargo.toml patch below drops a dependency, so `--locked` can't be used;
# instead assert after the build that the lockfile only lost entries.
lock_snapshot

# --- Drop jemalloc (avoids the jemalloc-sys ./configure failure under zig) ---
# 1) Remove the #[global_allocator] block in crates/core/main.rs:
#      #[cfg(all(target_env = "musl", target_pointer_width = "64"))]
#      #[global_allocator]
#      static ALLOC: jemallocator::Jemalloc = jemallocator::Jemalloc;
sed -i '/^#\[cfg(all(target_env = "musl", target_pointer_width = "64"))\]$/d' crates/core/main.rs
sed -i '/^#\[global_allocator\]$/d' crates/core/main.rs
sed -i '/^static ALLOC: jemallocator::Jemalloc = jemallocator::Jemalloc;$/d' crates/core/main.rs
# 2) Remove the target-specific jemallocator dependency from Cargo.toml — even
#    with the code gone, cargo still compiles a declared target dependency (and
#    thus jemalloc-sys). Range-delete the whole section through its trailing
#    blank line so it is robust to extra keys.
sed -i "/^\[target\..*\.dependencies\.jemallocator\]$/,/^$/d" Cargo.toml
# Fail loudly if upstream restructured and the patch missed an active reference.
# (Comments in main.rs still say "jemalloc"; only the live code/dep say
# "jemallocator", so grep for the crate name specifically.)
if grep -nq jemallocator crates/core/main.rs Cargo.toml; then
  echo "ERROR: jemallocator references remain after patch:" >&2
  grep -n jemallocator crates/core/main.rs Cargo.toml >&2
  exit 1
fi

cargo zigbuild --release --target riscv64gc-unknown-linux-musl
lock_assert_pruned_only
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/rg out/rg
file out/rg
