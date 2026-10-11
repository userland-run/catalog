// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Tiny TOML reader — just enough for recipe.toml (top-level keys, [tables],
// string/int/bool/array values, and inline tables like `env = { }`). Not a
// general TOML parser; it deliberately covers only the recipe schema so the
// catalog tooling stays dependency-free.
//
// Anything outside that subset THROWS rather than being silently misparsed:
// [[array-of-tables]], dotted table names / dotted keys, multi-line arrays or
// inline tables, multi-line or 'literal' strings, floats/dates, and stray lines
// without `=`. If a recipe needs more, extend this parser (with tests) first.

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function parseKey(raw) {
  const k = raw.trim();
  if (BARE_KEY.test(k)) return k;
  if (/^"[^"\\]*"$/.test(k)) return k.slice(1, -1);                // simple quoted key
  throw new Error(`toml: unsupported key ${JSON.stringify(k)} — dotted/complex keys are not supported`);
}

// True when every quote/bracket/brace in s is closed (s is one complete value).
function balanced(s) {
  let depth = 0, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== "\\") inStr = !inStr;
    else if (!inStr && (c === "[" || c === "{")) depth++;
    else if (!inStr && (c === "]" || c === "}")) depth--;
  }
  return depth === 0 && !inStr;
}

function parseValue(raw) {
  const s = raw.trim();
  if (s === "") throw new Error("toml: missing value after `=`");
  if (s.startsWith('"""') || s.startsWith("'")) throw new Error(`toml: multi-line / literal strings are not supported: ${s.slice(0, 40)}`);
  if (s.startsWith('"')) return JSON.parse(s);                       // basic string
  if ((s.startsWith("[") || s.startsWith("{")) && !balanced(s))
    throw new Error(`toml: multi-line arrays / inline tables are not supported: ${s.slice(0, 40)}`);
  if (s.startsWith("[")) {                                           // array
    if (!s.endsWith("]")) throw new Error(`toml: trailing content after array: ${s.slice(0, 40)}`);
    const inner = s.slice(1, s.lastIndexOf("]")).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map((x) => parseValue(x));
  }
  if (s.startsWith("{")) {                                           // inline table
    if (!s.endsWith("}")) throw new Error(`toml: trailing content after inline table: ${s.slice(0, 40)}`);
    const inner = s.slice(1, s.lastIndexOf("}")).trim();
    const obj = {};
    if (inner) for (const pair of splitTopLevel(inner)) {
      const eq = pair.indexOf("=");
      if (eq < 0) throw new Error(`toml: inline table entry without '=': ${pair.trim()}`);
      obj[parseKey(pair.slice(0, eq))] = parseValue(pair.slice(eq + 1));
    }
    return obj;
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^[+-]?\d+$/.test(s)) return Number(s);
  throw new Error(`toml: unsupported value ${JSON.stringify(s.slice(0, 40))} (floats, dates and bare words are not supported)`);
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
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n];
    const hash = findCommentStart(line);
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    const where = `line ${n + 1}`;
    try {
      if (line.startsWith("[[")) throw new Error("toml: [[array of tables]] is not supported");
      if (line.startsWith("[")) {
        if (!line.endsWith("]")) throw new Error(`toml: malformed table header ${line}`);
        const name = line.slice(1, -1).trim();
        if (!BARE_KEY.test(name)) throw new Error(`toml: unsupported table name [${name}] (dotted/quoted table names are not supported)`);
        table = root[name] = root[name] || {};
        continue;
      }
      const eq = line.indexOf("=");
      if (eq < 0) throw new Error(`toml: expected 'key = value', got ${JSON.stringify(line.slice(0, 40))}`);
      table[parseKey(line.slice(0, eq))] = parseValue(line.slice(eq + 1));
    } catch (e) {
      throw new Error(`${e.message} (${where})`);
    }
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
