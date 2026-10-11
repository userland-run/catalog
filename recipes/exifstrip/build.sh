#!/usr/bin/env bash
# Build exifstrip into ./out/exifstrip as a wasm32-wasip1 module.
#
# Source lives in the nano repo at apps/core/build/exifstrip (a standalone bin
# crate with no runtime dependencies — no wasm-bindgen, no threads). We clone
# nano at the pinned rev, build the crate for wasm32-wasip1, and copy the module
# out. EXIFSTRIP_SRC=<nano checkout> builds from a local tree instead.
set -euo pipefail
cd "$(dirname "$0")"

REPO="https://github.com/userland-run/nano"
REV="${EXIFSTRIP_REV:-main}"

rustup target add wasm32-wasip1 >/dev/null 2>&1 || true

if [ -n "${EXIFSTRIP_SRC:-}" ]; then
  CRATE="$EXIFSTRIP_SRC/apps/core/build/exifstrip"
else
  rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
  CRATE=".src/apps/core/build/exifstrip"
fi

cargo build --release --target wasm32-wasip1 --manifest-path "$CRATE/Cargo.toml"

mkdir -p out
cp "$CRATE/target/wasm32-wasip1/release/exifstrip.wasm" out/exifstrip
echo "built out/exifstrip ($(wc -c < out/exifstrip) bytes)"
