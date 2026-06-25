// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Tiny TOML reader — just enough for recipe.toml (top-level keys, [tables],
// string/int/bool/array values, and inline tables like `env = { }`). Not a
// general TOML parser; it deliberately covers only the recipe schema so the
// catalog tooling stays dependency-free.

function parseValue(raw) {
  const s = raw.trim();
  if (s === "") return "";
  if (s.startsWith('"')) return JSON.parse(s);                       // basic string
  if (s.startsWith("[")) {                                           // array
    const inner = s.slice(1, s.lastIndexOf("]")).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map((x) => parseValue(x));
  }
  if (s.startsWith("{")) {                                           // inline table
    const inner = s.slice(1, s.lastIndexOf("}")).trim();
    const obj = {};
    if (inner) for (const pair of splitTopLevel(inner)) {
      const eq = pair.indexOf("=");
      obj[pair.slice(0, eq).trim()] = parseValue(pair.slice(eq + 1));
    }
    return obj;
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

// Split on commas that are not inside quotes/brackets/braces.
function splitTopLevel(s) {
  const out = [];
  let depth = 0, inStr = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== "\\") inStr = !inStr;
    if (!inStr) {
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
      else if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function parseToml(text) {
  const root = {};
  let table = root;
  for (let line of text.split("\n")) {
    const hash = findCommentStart(line);
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      const name = line.slice(1, line.indexOf("]")).trim();
      table = root[name] = root[name] || {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    table[line.slice(0, eq).trim()] = parseValue(line.slice(eq + 1));
  }
  return root;
}

function findCommentStart(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && line[i - 1] !== "\\") inStr = !inStr;
    if (line[i] === "#" && !inStr) return i;
  }
  return -1;
}
