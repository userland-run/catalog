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
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 / ensure_cargo_zigbuild (supply-chain pins)
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
  # Pinned to the nano v0.1.0 release asset; when NANO_RELEASE points at another
  # release, pass its sha256 as BUSYBOX_SHA256 (a mismatch fails the build).
  fetch_sha256 "$NANO_RELEASE/busybox" out/busybox "${BUSYBOX_SHA256:-65b782d6b2578d107a76de1d13e1256c255ffe7c0f30d1579027650ce54f9cab}"
fi
chmod +x out/busybox
file out/busybox
