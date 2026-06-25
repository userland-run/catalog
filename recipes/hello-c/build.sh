#!/usr/bin/env bash
# Build the hello-c app into ./out/hello-c as a static RV64GC musl ELF.
# zig bundles musl and cross-compiles to riscv64 with no extra toolchain.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p out
zig cc -target riscv64-linux-musl -static -march=baseline_rv64 -Oz \
  src/hello.c -o out/hello-c

# Sanity: must be a static RISC-V ELF (the pipeline re-checks with validate-elf.sh).
file out/hello-c
