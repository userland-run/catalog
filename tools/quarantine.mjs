#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Matrix filter for quarantined recipes (see tools/lib/quarantine.mjs).
//
//   node tools/quarantine.mjs [--recipes recipes] <name>...
//
// Prints the names that are NOT quarantined (one per line, input order) on
// stdout; for each quarantined one prints a GitHub `::warning::` with its reason
// on stderr. Names without a recipe.toml pass through unchanged (the callers
// already handle missing recipes). An invalid quarantine config (non-boolean
// `publish`, missing `reason`) or an unparseable recipe.toml exits 2 — fail
// closed rather than silently dropping or building a recipe.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseToml } from "./lib/toml.mjs";
import { quarantineOf } from "./lib/quarantine.mjs";

const args = process.argv.slice(2);
let recipesDir = "recipes";
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--recipes") recipesDir = args[++i];
  else if (args[i]) names.push(args[i]);
}

const keep = [];
try {
  for (const name of names) {
    const p = resolve(recipesDir, name, "recipe.toml");
    if (!existsSync(p)) { keep.push(name); continue; }
    const q = quarantineOf(parseToml(readFileSync(p, "utf8")), name);
    if (q) console.error(`::warning::skip ${name}: quarantined ([status] publish = false) — ${q.reason}`);
    else keep.push(name);
  }
} catch (e) {
  console.error(`::error::${e.message}`);
  process.exit(2);
}
if (keep.length) process.stdout.write(keep.join("\n") + "\n");
