// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Recipe quarantine — an explicit, documented way to take a known-broken recipe
// out of the build/publish/conformance matrices WITHOUT weakening the
// fail-closed pipeline for everything else:
//
//   [status]
//   publish = false
//   reason  = "why it is quarantined + what unblocks it"
//
// A quarantined recipe is never built, conformed, packaged or signed. Versions it
// published earlier stay in the index: publish.mjs carries the prior generation's
// apps + cas blobs forward (verified), so consumers keep the last good build.
//
// Fail-closed on the config itself: `publish` must be a boolean, and
// `publish = false` without a non-empty `reason` is an error (no silent opt-outs).

/** @returns {null | { reason: string }} null when the recipe is publishable. */
export function quarantineOf(recipe, name = recipe && recipe.name) {
  const st = recipe && recipe.status;
  if (!st || st.publish === undefined) return null;
  if (typeof st.publish !== "boolean") {
    throw new Error(`recipe ${name}: [status] publish must be true or false (got ${JSON.stringify(st.publish)})`);
  }
  if (st.publish) return null;
  if (typeof st.reason !== "string" || st.reason.trim() === "") {
    throw new Error(`recipe ${name}: [status] publish = false requires a non-empty reason = "..."`);
  }
  return { reason: st.reason.trim() };
}
