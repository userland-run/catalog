#!/usr/bin/env bash
# Build the sqlite3 command-line shell into ./out/sqlite3 as a wasm32-wasip1 module.
#
# Source: the official SQLite amalgamation (public domain), pinned by version and
# sha256 (the download page publishes SHA3-256; both are checked). Compiled with
# wasi-sdk clang: shell.c + sqlite3.c, single-threaded, no extension loading, and
# the WASI emulation shims for signal/getpid/process clocks/mman that the shell uses.
#
# Needs WASI_SDK_PATH (a wasi-sdk >= 24 install, e.g. ~/.local/wasi-sdk-34.0).
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # fetch_sha256 (supply-chain pin)

VER="3540000"           # SQLite 3.54.0
YEAR="2026"
SHA256="68e913b0fe8ec6b4e5f391c594a28872884e80d6cd042a1e50c957be46b5aa4d"
SHA3="7b670a62fdfbd672b75fef004cb703c8a3e87d3a5cc7d675b4a08337004a2d93"
: "${WASI_SDK_PATH:?set WASI_SDK_PATH to a wasi-sdk install}"
CC="$WASI_SDK_PATH/bin/clang"
SYSROOT="$WASI_SDK_PATH/share/wasi-sysroot"

rm -rf .src && mkdir -p .src
fetch_sha256 "https://sqlite.org/${YEAR}/sqlite-amalgamation-${VER}.zip" .src/sqlite.zip "$SHA256"
if command -v openssl >/dev/null && openssl dgst -sha3-256 /dev/null >/dev/null 2>&1; then
  got=$(openssl dgst -sha3-256 .src/sqlite.zip | awk '{print $NF}')
  [ "$got" = "$SHA3" ] || { echo "sha3-256 mismatch: $got" >&2; exit 1; }
fi
(cd .src && unzip -q sqlite.zip)
S=".src/sqlite-amalgamation-${VER}"

DEFS=(
  -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_WAL
  -DSQLITE_OMIT_SHARED_CACHE -DSQLITE_OMIT_DEPRECATED
  -DSQLITE_DEFAULT_MEMSTATUS=0 -DSQLITE_DQS=0 -DSQLITE_ENABLE_MATH_FUNCTIONS
  -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_DBSTAT_VTAB
  -DSQLITE_NOHAVE_SYSTEM -DSQLITE_SHELL_IS_UTF8=1 -DHAVE_READLINE=0 -DHAVE_EDITLINE=0
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN
)
mkdir -p out
"$CC" --target=wasm32-wasip1 --sysroot="$SYSROOT" -Os "${DEFS[@]}" -I"$S" \
  "$S/shell.c" "$S/sqlite3.c" -o out/sqlite3 \
  -lwasi-emulated-signal -lwasi-emulated-getpid -lwasi-emulated-process-clocks -lwasi-emulated-mman \
  -Wl,--strip-all -Wl,-z,stack-size=1048576
echo "built out/sqlite3 ($(wc -c < out/sqlite3) bytes)"
