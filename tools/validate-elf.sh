#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
# Copyright (C) 2026 And The Next GmbH - https://userland.run
#
# Fast pre-flight before booting nano: a candidate binary must be a fully static
# RV64GC (rv64imafdc) ELF with no unsupported extensions. Anything else is
# rejected here, cheaply, before the conformance run.
set -euo pipefail

f="${1:-}"
if [[ -z "$f" || ! -f "$f" ]]; then
  echo "usage: validate-elf.sh <binary>" >&2
  exit 2
fi

file "$f" | grep -q "ELF 64-bit LSB .*RISC-V"        || { echo "not RISC-V ELF"; exit 1; }
# Accept plain-static and static-PIE: both are self-contained (no ld.so). nano's
# ELF loader handles the static-PIE relocations (busybox ships this way).
file "$f" | grep -Eq "statically linked|static-pie linked" || { echo "not static"; exit 1; }

# Reject only a *dynamic* executable: a PT_INTERP (an ld.so request) or NEEDED
# shared libraries. A static-PIE has a PT_DYNAMIC (RELA relocs) but neither.
if readelf -l "$f" 2>/dev/null | grep -q "Requesting program interpreter"; then
  echo "has PT_INTERP (needs ld.so)"; exit 1
fi
if readelf -d "$f" 2>/dev/null | grep -q "(NEEDED)"; then
  echo "has NEEDED shared libraries"; exit 1
fi

# Arch attributes must not advertise unsupported extensions (e.g. v = vector):
if readelf -A "$f" 2>/dev/null | grep -Eq "_v[0-9]"; then
  echo "uses unsupported RISC-V extension"; exit 1
fi

echo "ok: static RV64GC ELF"
