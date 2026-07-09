#!/usr/bin/env bash
# Produce ./out as a guest-FS-rooted tree: opencode's Node bundle under
# /usr/local/lib/opencode (+ its flat node_modules and WASM assets), a
# /usr/local/bin/opencode wrapper that execs it on the catalog `node`, and a
# default config at /root/.config/opencode/opencode.json. Pure-JS +
# architecture-independent WASM; runs on `node`.
#
# The bundle is built OFF-VM (needs Bun; see recipe.toml header). This script only
# assembles a pre-built dist into the guest tree. Source (first hit wins):
#   1. $OPENCODE_DIST                       — a dir holding index-nano.js + *.wasm + node_modules
#   2. ../../../opencode/packages/opencode/dist/cli   — a sibling opencode checkout
#   3. ../../../terminal/public/opencode    — the terminal's staged bundle (dev)
set -euo pipefail
cd "$(dirname "$0")"
rm -rf out && mkdir -p out/usr/local/lib/opencode out/usr/local/bin out/root/.config/opencode

src=""
if [ -n "${OPENCODE_DIST:-}" ] && [ -f "$OPENCODE_DIST/index-nano.js" ]; then
  src="$OPENCODE_DIST"
elif [ -f "../../../opencode/packages/opencode/dist/cli/index-nano.js" ]; then
  src="../../../opencode/packages/opencode/dist/cli"
elif [ -f "../../../terminal/public/opencode/index-nano.js" ]; then
  src="../../../terminal/public/opencode"
fi
: "${src:?set OPENCODE_DIST to the dir containing index-nano.js + *.wasm + node_modules}"

LIB=out/usr/local/lib/opencode
# Bundle + WASM assets + flat node_modules (cp -R does not create macOS ._ cruft).
cp "$src/index-nano.js" "$LIB/"

# HARD REQUIREMENT — a guest node with V8 i18n (Unicode-property regex) enabled:
# The bundle uses 100 `\p{...}` regex escapes (L, Nd, Nl, Emoji_Component,
# Extended_Pictographic, Script=Latin, ...). The CURRENTLY SHIPPED guest node
# (images/node) is built `--with-intl=none` ("v8_enable_i18n_support": 0), so V8
# rejects EVERY `\p{...}` at COMPILE time ("Invalid regular expression: /\p{L}+/gu:
# Invalid property name") and the 16 MB ESM module never loads. Verified via
# headless conformance: loaded=true but exit 1, SyntaxError at compile, ~3e9 insns.
# FIX: rebuild node with i18n ON — `--with-intl=small-icu` (already in
# nano/build/node-riscv/Dockerfile:105 but not yet rebuilt/shipped) or full-icu.
# This is the same ICU node work that unblocks prettier.
#
# Under small-icu, general-category + Emoji properties compile, but the Unicode
# *script* tables are absent, so the single `\p{Script=Latin}` still fails →
# rewrite it to \p{L} (any letter; negligibly broader for opencode). Under full-icu
# this patch is a harmless no-op-ish narrowing. Under the current intl=none node it
# is insufficient on its own (the node MUST be rebuilt).
sed -i.bak 's/{Script=Latin}/{L}/g' "$LIB/index-nano.js" && rm -f "$LIB/index-nano.js.bak"

# opencode's DB layer opens node:sqlite in WAL mode (`PRAGMA journal_mode = WAL`).
# WAL needs a shared-memory (-shm) mmap the emulator's FS doesn't provide, so the
# guest node fails with SQLITE_IOERR_SHMOPEN and `opencode serve` hangs on DB init.
# The rollback-journal DELETE mode works in-guest (needs the emulator's fcntl
# advisory-lock + fsync no-op support, present since 2026-07-08). Rewrite WAL ->
# DELETE: durable rollback journalling, no shared memory. (wal_checkpoint pragmas
# become harmless no-ops on a non-WAL DB.) A JS string-literal edit, so the length
# change is irrelevant.
sed -i.bak 's/journal_mode = WAL/journal_mode = DELETE/g' "$LIB/index-nano.js" && rm -f "$LIB/index-nano.js.bak"
cp "$src"/*.wasm "$LIB/"
cp -R "$src/node_modules" "$LIB/"

# web-tree-sitter loads its core via new URL("tree-sitter.wasm", import.meta.url);
# the Bun bundler emits it hashed. Provide the unhashed alias if it's missing.
if [ ! -f "$LIB/tree-sitter.wasm" ]; then
  core=$(ls "$LIB"/tree-sitter-*.wasm 2>/dev/null | grep -viE 'bash|powershell' | head -1 || true)
  [ -n "$core" ] && cp "$core" "$LIB/tree-sitter.wasm"
fi

# ESM marker so node runs index-nano.js as a module.
cat > "$LIB/package.json" <<'JSON'
{ "type": "module", "name": "opencode-nano", "version": "1.17.15" }
JSON

# In-guest loopback proxy (P2): a --require preload that listens on
# 127.0.0.1:8787 and forwards to $NANO_NET_TARGET over /dev/__net__ (default
# nanoinfer.internal = the local model; set it to a cloud base URL to switch).
# The package.json above says "type":"module", but the .cjs extension keeps the
# preload CommonJS, which --require needs.
cp nano-net-proxy.cjs "$LIB/"

# Wrapper: --conditions=node selects opencode's node (not bun) conditional imports
# (#sqlite -> node:sqlite, #pty -> the shim). Runs on the catalog `node`.
# The preload starts the loopback proxy inside the same process (fork is
# serialized in the VM — no separate proxy process).
# --single-threaded-gc is REQUIRED for `serve`: opencode's startup allocates
# heavily (schema/route graphs) → repeated V8 Mark-Compact GC, and V8's default
# parallel/concurrent GC spawns helper threads that thrash the emulator's thread
# scheduler (same failure mode as the epoll ping-pong). That turned serve's DB-to-
# listen step into an 11+min compute wall (hot pc = MarkObjectsFromClientHeaps).
# Forcing GC onto one thread collapses it: serve reaches listening in ~63s.
# Harmless for the fast command paths (--help etc.).
cat > out/usr/local/bin/opencode <<'SH'
#!/bin/sh
exec node --single-threaded-gc --conditions=node --require /usr/local/lib/opencode/nano-net-proxy.cjs /usr/local/lib/opencode/index-nano.js "$@"
SH
chmod +x out/usr/local/bin/opencode

# Default config: custom OpenAI-compatible provider pointing at the in-guest
# loopback proxy (127.0.0.1:8787 -> /dev/__net__; local nanoinfer OR cloud),
# autoupdate off (the guest has no update path and it would hang on first run).
cat > out/root/.config/opencode/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "provider": {
    "nano": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "nano-local" },
      "models": {
        "nanoinfer-local": { "name": "nanoinfer (local)", "limit": { "context": 2048, "output": 512 } }
      }
    }
  }
}
JSON

echo "opencode: $(find out -type f | wc -l | tr -d ' ') files, $(du -sh out | cut -f1) total"
