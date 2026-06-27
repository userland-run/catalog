#!/usr/bin/env bash
# Produce ./out/busybox: the prebuilt static RV64GC BusyBox ELF, sourced exactly
# like recipes/busybox/build.sh (no toolchain needed). This recipe is an internal
# conformance smoke for the harness's deterministic I/O fixtures — it reuses the
# busybox guest rather than shipping a new app.
#
# Sourcing (first hit wins):
#   1. $NANO_IMAGES/busybox            (local dev)
#   2. ../../../nano/images/busybox    (sibling nano checkout)
#   3. $NANO_RELEASE/busybox           (CI: a nano release asset)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
src=""
if [ -n "${NANO_IMAGES:-}" ] && [ -f "$NANO_IMAGES/busybox" ]; then
  src="$NANO_IMAGES/busybox"
elif [ -f "../../../nano/images/busybox" ]; then
  src="../../../nano/images/busybox"
fi
if [ -n "$src" ]; then
  cp "$src" out/busybox
else
  : "${NANO_RELEASE:?set NANO_IMAGES or NANO_RELEASE to source the busybox ELF}"
  curl -fsSL "$NANO_RELEASE/busybox" -o out/busybox
fi
chmod +x out/busybox
file out/busybox
