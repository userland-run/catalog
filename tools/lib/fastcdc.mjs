// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// FastCDC content-defined chunking (32-bit gear variant, normalized chunking).
// Splits a byte stream at content-derived boundaries so identical regions across
// different apps (shared musl, libstdc++) produce identical chunks — the basis
// of the catalog's content-addressed dedup.
//
// The gear table is generated deterministically from a fixed seed so chunk
// boundaries are reproducible on any machine (a chunk's bytes → always the same
// boundaries → same sha256 → dedup works across publishes).

const MASK32 = 0xffffffff;

// 256-entry gear table from a splitmix32-style seeded PRNG (deterministic).
function buildGear() {
  const gear = new Uint32Array(256);
  let s = 0x9e3779b9 >>> 0;
  for (let i = 0; i < 256; i++) {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    gear[i] = z;
  }
  return gear;
}
const GEAR = buildGear();

// Top-k-bits mask of a 32-bit word (more set bits → rarer cut → larger chunks).
const topBits = (k) => (k <= 0 ? 0 : (MASK32 << (32 - k)) >>> 0);

/**
 * @param {Uint8Array} buf
 * @param {object} [opts] minSize/avgSize/maxSize in bytes
 * @returns {Array<{start:number,end:number}>} chunk ranges covering buf
 */
export function chunk(buf, opts = {}) {
  const MIN = opts.minSize ?? 1 << 20;  // 1 MB
  const AVG = opts.avgSize ?? 1 << 21;  // 2 MB
  const MAX = opts.maxSize ?? 1 << 22;  // 4 MB
  const bits = Math.round(Math.log2(AVG));
  const maskS = topBits(bits + 2); // below avg: harder to cut
  const maskL = topBits(bits - 2); // above avg: easier to cut

  const cut = (off) => {
    const remaining = buf.length - off;
    if (remaining <= MIN) return remaining;
    const end = Math.min(MAX, remaining);
    const normal = Math.min(AVG, remaining);
    let hash = 0;
    let i = MIN;
    for (; i < normal; i++) {
      hash = ((hash << 1) + GEAR[buf[off + i]]) >>> 0;
      if ((hash & maskS) === 0) return i + 1;
    }
    for (; i < end; i++) {
      hash = ((hash << 1) + GEAR[buf[off + i]]) >>> 0;
      if ((hash & maskL) === 0) return i + 1;
    }
    return end;
  };

  const ranges = [];
  let off = 0;
  while (off < buf.length) {
    const len = cut(off);
    ranges.push({ start: off, end: off + len });
    off += len;
  }
  return ranges;
}
