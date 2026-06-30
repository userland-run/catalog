# nano app catalog

The build, conformance, and distribution pipeline for nano-compatible RISC-V
applications. A submission is a pull request that adds one **recipe**; CI compiles
it to a static RV64GC musl binary, runs it on the **real nano runtime headless**,
and — on merge — packages it into a signed, content-addressed artifact published
to a CDN. No always-on backend.

> 📚 **Documentation: <https://userland.run/docs/sdk-catalog>** (installing apps) and
> [provisioning & recipes](https://userland.run/docs/sdk-provision). See also
> [Part of userland.run](#part-of-userlandrun).

> Specification: [`specs/nano/publish-pipeline.md`](https://github.com/userland-run/specs/blob/main/nano/publish-pipeline.md)

There are currently **~48 published recipes** — BusyBox, Node.js, the TypeScript/ESLint/Prettier
toolchain, and CLI tools like ripgrep, fd, bat, delta, jq/yq, just, tokei, and more. Some apps
(notably `node`) carry an **AppRecipe** block in their signed manifest — a warmup/V8-snapshot
launcher plus run-payload templates — so the SDK's generic `provision()` can install and run them
with no app-specific code. Curated **collections** (`collections.toml`, e.g. `node-dev`, `git`)
bundle related apps for one-call install.

## Layout

```
recipes/<name>/
  recipe.toml          identity, source, entrypoint, maintainer
  build.sh             produces ./out/<binary> (static RV64GC ELF)
  test/
    run.json           conformance invocation + expected result
    fixtures/          input files staged into the guest VFS
tools/
  validate-elf.sh      pre-flight static / arch checks
  nano-conformance.mjs headless nano runner → JSON verdict
  gate.mjs             pass/fail on the 5 conformance checks
  package.mjs          strip, gzip, chunk, hash, sign, manifest
  publish.mjs          npm (→ jsDelivr) submission + index/generation bump
  mirror-r2.mjs        optional Cloudflare R2 mirror
  nano-syscalls.json   allowed syscall set, pinned per nano release
  vendor/              pinned nano host modules (memfs, host protocol)
keys/
  catalog.pub          Ed25519 public key (private key is a CI secret)
.github/workflows/
  publish.yml          the pipeline (test on PR; publish on merge to main)
```

## Submitting an app

1. Open a PR adding `recipes/<name>/` with `recipe.toml`, `build.sh`, and
   `test/run.json` (plus any `test/fixtures/`).
2. CI compiles, validates, and runs conformance on the literal nano runtime.
   The PR shows pass/fail with the precise reason.
3. A maintainer merges. The publish job packages, signs, and pushes to the CDN,
   then bumps the catalog generation.

No binary reaches the catalog without passing on the runtime users actually run.

## Local development

```bash
# Validate an ELF is static RV64GC baseline:
tools/validate-elf.sh recipes/<name>/out/<binary>

# Run conformance (needs nano.min.wasm + nano.trace.wasm from the nano release):
NANO_VERSION=0.1.0 node tools/nano-conformance.mjs recipes/<name>/out/<binary> \
  --recipe recipes/<name> --report verdict.json
node tools/gate.mjs verdict.json tools/nano-syscalls.json

# Package + dry-run publish (no secrets needed):
node tools/package.mjs artifacts --out dist
node tools/publish.mjs dist            # --dry-run unless NODE_AUTH_TOKEN is set
```

## Consuming the catalog

Apps are installed at runtime through the [SDK](https://github.com/userland-run/sdk): the
`Catalog` client resolves the signed index from the CDN (jsDelivr by default — overridable for
mirrors or tests), verifies the Ed25519 signature and content hashes, and writes the binary into
the guest VFS. `nano.installApp("typescript")` then `nano.run("tsc --version")`, or
`provision(new Catalog(), "node@25.4.0", …)` for the recipe-driven path.

## Part of userland.run

This is one repo in the **[userland.run](https://userland.run)** workspace:

| Repo | What it is |
| ---- | ---------- |
| [nano](https://github.com/userland-run/nano) | The RV64GC → WASM emulator core (the runtime apps are conformance-tested against) |
| [sdk](https://github.com/userland-run/sdk) | `@userland-run/nano-sdk` — installs + runs catalog apps (`Catalog`, `installApp`, `provision`) |
| [terminal](https://github.com/userland-run/terminal) | `<nano-terminal>` web component with a built-in catalog browser |
| **[catalog](https://github.com/userland-run/catalog)** | Signed app marketplace + publish pipeline — **this repo** |
| [website](https://github.com/userland-run/website) | Landing page + the hosted docs at [userland.run/docs](https://userland.run/docs/) |

Licensed AGPL-3.0-only OR LicenseRef-UEL — see [LICENSE.md](./LICENSE.md).
