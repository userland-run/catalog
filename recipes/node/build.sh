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
  curl -fsSL "$NANO_RELEASE/node" -o out/node
fi

chmod +x out/node
file out/node

# publish trigger: catalog migration
