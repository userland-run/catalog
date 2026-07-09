#!/usr/bin/env bash
# Build a minimal static git into ./out/git as a static RV64GC musl ELF.
#
# git is C with a Makefile (not cargo), so we drive it with `zig cc` as the
# cross compiler (zig bundles musl + a C cross-toolchain, like the other C
# recipes here). Two wrinkles vs. a Rust recipe:
#   1. git needs zlib — we cross-build a static zlib first and point ZLIB_PATH
#      at it. Everything else (curl/openssl/expat/tcltk/gettext/perl/python) is
#      dropped via NO_* so the binary has no other deps.
#   2. git's Makefile runs feature-detection *test programs*; those can't run
#      when cross-compiling, so we pre-answer them in config.mak. If CI trips on
#      a new autodetect, add the corresponding NO_*/HAVE_* line there.
set -euo pipefail
cd "$(dirname "$0")"

ZTARGET="riscv64-linux-musl"
ZCC="zig cc -target ${ZTARGET} -march=baseline_rv64"
command -v zig >/dev/null 2>&1 || { echo "ERROR: zig not on PATH (needed for the musl cross-compile)"; exit 1; }

rm -rf .zlib .src zprefix out
PREFIX="$PWD/zprefix"

# --- static zlib (riscv64-musl) ---
git clone --depth 1 --branch v1.3.1 https://github.com/madler/zlib .zlib
( cd .zlib
  CC="$ZCC" CHOST=riscv64 ./configure --static --prefix="$PREFIX"
  make -j"$(nproc)"
  make install )

# --- git ---
git clone --depth 1 --branch v2.47.1 https://github.com/git/git .src
cd .src

cat > config.mak <<MAK
CC = ${ZCC}
AR = zig ar
RANLIB = zig ranlib
CFLAGS = -O2 -static -I${PREFIX}/include
LDFLAGS = -static -L${PREFIX}/lib
ZLIB_PATH = ${PREFIX}
uname_S = Linux
# Drop every optional dependency — opencode only needs local repo introspection.
NO_OPENSSL = YesPlease
NO_CURL = YesPlease
NO_EXPAT = YesPlease
NO_TCLTK = YesPlease
NO_GETTEXT = YesPlease
NO_PYTHON = YesPlease
NO_PERL = YesPlease
NO_ICONV = YesPlease
NO_GITWEB = YesPlease
NO_REGEX = YesPlease
# Cross-compile: the Makefile can't run its probe binaries, so answer them here.
uname_M = riscv64
NO_STRLCPY = YesPlease
HAVE_CLOCK_GETTIME = YesPlease
HAVE_CLOCK_MONOTONIC = YesPlease
HAVE_GETDELIM = YesPlease
MAK

# Build just the monolithic git binary (skips docs, git-gui, subtree, etc.).
make -j"$(nproc)" strip git

mkdir -p ../out
cp git ../out/git
echo "built: $(file ../out/git 2>/dev/null || ls -la ../out/git)"
