#!/usr/bin/env bash
# Produce ./out/node: the prebuilt static RV64GC Node.js v25 ELF (~52 MB).
#
# Sourcing (first hit wins):
#   1. $NANO_IMAGES/node               (local dev: point at nano/images)
#   2. a sibling ../../../nano/images/node checkout
#   3. $NANO_RELEASE/node              (CI: a nano release asset)
# The from-source build lives in nano/build/node-riscv/Dockerfile (relocating here
# is a follow-up); for now the recipe vendors that Dockerfile's output.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
mkdir -p out

src=""
if [ -n "${NANO_IMAGES:-}" ] && [ -f "$NANO_IMAGES/node" ]; then
  src="$NANO_IMAGES/node"
elif [ -f "../../../nano/images/node" ]; then
  src="../../../nano/images/node"
fi

if [ -n "$src" ]; then
  cp "$src" out/node
else
  : "${NANO_RELEASE:?set NANO_IMAGES or NANO_RELEASE to source the node ELF}"
  # Pinned to the nano v0.1.0 release asset; when NANO_RELEASE points at another
  # release, pass its sha256 as NODE_ELF_SHA256 (a mismatch fails the build).
  fetch_sha256 "$NANO_RELEASE/node" out/node "${NODE_ELF_SHA256:-1a77fe13fe35bd67f1d61291667553e9dea2f6bb6985d14ab64656d4d309648c}"
fi

chmod +x out/node
file out/node

# publish trigger: catalog migration
