#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Scaffold a new single-binary catalog recipe (recipe.toml + build.sh +
// test/run.json) from a one-line spec, using the validated riscv64gc-musl build
// templates. Cuts the per-recipe cost to minutes; the golden is filled in later
// by `capture-golden.mjs` after the first local build.
//
// Usage:
//   node tools/new-recipe.mjs <name> --lang rust|go|c --src <git#rev | path>
//        [--bin <binary>] [--test '<cmd...>'] [--pkg <go-main-pkg>]
//        [--version X.Y.Z] [--topics Data,Text] [--caveats net,big]
//
// Examples:
//   node tools/new-recipe.mjs fd  --lang rust --src https://github.com/sharkdp/fd#v10.2.0 --bin fd --test 'fd --version'
//   node tools/new-recipe.mjs yq  --lang go   --src https://github.com/mikefarah/yq#v4.44.3 --test 'yq --version'
//   node tools/new-recipe.mjs jq  --lang c    --src https://github.com/jqlang/jq#jq-1.7.1   --test 'jq --version'

import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) a[t.slice(2)] = argv[++i];
    else a._.push(t);
  }
  return a;
}

function splitSrc(src) {
  // "https://github.com/u/r#v1.2.3" -> { git, rev }; a bare path -> { path }.
  if (/^https?:\/\/|^git@/.test(src)) {
    const [git, rev] = src.split("#");
    return { git, rev: rev || "main" };
  }
  return { path: src };
}

const RUST = (repo, rev, bin, pkg, features) => {
  const sel = [
    pkg ? `-p ${pkg}` : "",
    `--bin ${bin}`,
    features ? `--no-default-features --features ${features}` : "",
  ].filter(Boolean).join(" ");
  return `#!/usr/bin/env bash
# Build ${bin} into ./out/${bin} as a static RV64GC musl ELF via cargo-zigbuild —
# it drives the build through zig (bundles musl + a C cross-compiler) and handles
# the musl/libgcc_s quirks that a raw "cargo build + zig linker" trips over.
set -euo pipefail
cd "$(dirname "$0")"
REPO="${repo}"
REV="${rev}"

rustup target add riscv64gc-unknown-linux-musl
command -v cargo-zigbuild >/dev/null 2>&1 || pipx install cargo-zigbuild >/dev/null 2>&1 || cargo install cargo-zigbuild

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
cargo zigbuild --release --target riscv64gc-unknown-linux-musl SELECT
cd ..
mkdir -p out
cp .src/target/riscv64gc-unknown-linux-musl/release/${bin} out/${bin}
file out/${bin}
`;
};

const GO = (repo, rev, bin, pkg) => `#!/usr/bin/env bash
# Build ${bin} into ./out/${bin} as a static RV64GC ELF. CGO_ENABLED=0 makes a
# fully static binary with no libc dependency.
set -euo pipefail
cd "$(dirname "$0")"
REPO="${repo}"
REV="${rev}"

rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src
cd .src
mkdir -p ../out
GOOS=linux GOARCH=riscv64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../out/${bin} ${pkg}
cd ..
file out/${bin}
`;

const C = (src, bin) => `#!/usr/bin/env bash
# Build ${bin} into ./out/${bin} as a static RV64GC musl ELF. zig cc bundles musl
# and cross-compiles to riscv64 with no extra toolchain.
set -euo pipefail
cd "$(dirname "$0")"
export CC="zig cc -target riscv64-linux-musl"
export AR="zig ar"
mkdir -p out

# TODO: fetch + build the source. ${src.git ? `Repo: ${src.git} @ ${src.rev}` : `Local source: ${src.path}`}
# Single-file C app:
#   $CC -static -march=baseline_rv64 -Oz ${src.path || "src/" + bin + ".c"} -o out/${bin}
# Autotools/make project (clone, configure with the cross CC, make, copy):
#   rm -rf .src && git clone --depth 1 --branch "$REV" "$REPO" .src && cd .src
#   ./configure --host=riscv64-linux-musl CC="$CC" AR="$AR" LDFLAGS="-static" && make -j"$(nproc)"
#   cp <built-binary> ../out/${bin}

file out/${bin}
`;

function recipeToml({ name, version, lang, src, bin, topics, caveats }) {
  const lines = [
    `name = "${name}"`,
    `version = "${version}"`,
    `abi = "riscv64gc-linux-musl"`,
    ``,
  ];
  if (src.git) {
    lines.push(`[source]`, `git = "${src.git}"`, `rev = "${src.rev}"`, ``);
  } else {
    lines.push(`[source]`, `path = "${src.path}"`, ``);
  }
  lines.push(`[entrypoint]`, `argv = ["${bin}"]`, `env = { }`, ``);
  if (topics.length) lines.push(`[bundle]`, `topics = [${topics.map((t) => `"${t}"`).join(", ")}]`, ``);
  if (caveats.length) {
    lines.push(`[caveats]`, ...caveats.map((c) => `${c} = true`), ``);
  }
  lines.push(
    `[maintainer]`,
    `name = "userland.run"`,
    `contact = "https://github.com/userland-run/catalog"`,
    ``,
    `[status]`,
    `features = ["catalog.recipe.${name}"]`,
    ``,
  );
  return lines.join("\n");
}

function runJson(testCmd) {
  return JSON.stringify(
    {
      cmd: testCmd,
      env: { LANG: "C" },
      load: [],
      expect: {
        exitCode: 0,
        stdoutSha256: "TBD",     // fill via: node tools/capture-golden.mjs <name>
        maxInstructions: 2000000000,
        maxWallMs: 30000,
      },
    },
    null,
    2,
  ) + "\n";
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const name = a._[0];
  const lang = a.lang;
  if (!name || !lang || !a.src) {
    console.error("usage: new-recipe.mjs <name> --lang rust|go|c --src <git#rev|path> [--bin b] [--test 'cmd'] [--pkg .] [--version X] [--topics A,B] [--caveats net,big]");
    process.exit(2);
  }
  const bin = a.bin || name;
  const src = splitSrc(a.src);
  const version = a.version || (src.rev || "0.0.0").replace(/^v/, "").replace(/^[a-z]+-/, "");
  const topics = (a.topics || "").split(",").map((s) => s.trim()).filter(Boolean);
  const caveats = (a.caveats || "").split(",").map((s) => s.trim()).filter(Boolean);
  const testCmd = (a.test || `${bin} --version`).split(/\s+/);

  const dir = resolve(ROOT, "recipes", name);
  if (existsSync(dir)) { console.error(`recipe already exists: recipes/${name}`); process.exit(1); }
  mkdirSync(resolve(dir, "test"), { recursive: true });

  const build =
    lang === "rust" ? RUST(src.git, src.rev, bin, a.pkg, a.features) :
    lang === "go"   ? GO(src.git, src.rev, bin, a.pkg || ".") :
    lang === "c"    ? C(src, bin) :
    (() => { console.error(`unknown --lang ${lang} (rust|go|c)`); process.exit(2); })();

  writeFileSync(resolve(dir, "recipe.toml"), recipeToml({ name, version, lang, src, bin, topics, caveats }));
  writeFileSync(resolve(dir, "build.sh"), build);
  chmodSync(resolve(dir, "build.sh"), 0o755);
  writeFileSync(resolve(dir, "test/run.json"), runJson(testCmd));

  console.error(`scaffolded recipes/${name} (${lang}, bin=${bin}, v${version})`);
  console.error(`next: bash recipes/${name}/build.sh  &&  node tools/capture-golden.mjs ${name}`);
  if (lang === "c") console.error(`note: C recipes need the build command filled in (see the TODO in build.sh)`);
}

main();
