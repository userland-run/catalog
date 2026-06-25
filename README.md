# nano app catalog

The build, conformance, and distribution pipeline for nano-compatible RISC-V
applications. A submission is a pull request that adds one **recipe**; CI compiles
it to a static RV64GC musl binary, runs it on the **real nano runtime headless**,
and — on merge — packages it into a signed, content-addressed artifact published
to a CDN. No always-on backend.

> Specification: [`specs/nano/publish-pipeline.md`](https://github.com/userland-run/specs/blob/main/nano/publish-pipeline.md)

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

Licensed AGPL-3.0-only OR LicenseRef-UEL — see [LICENSE.md](./LICENSE.md).
