# License

The **nano app catalog** — the build, conformance, and distribution pipeline for
nano-compatible RISC-V applications (<https://userland.run>) — is **dual-licensed**.
You may use, modify, and distribute it under the terms of **either**:

- the **GNU Affero General Public License, version 3** (AGPL-3.0) — the
  open-source option; the full text is in [`LICENSE`](./LICENSE); or
- the **Userland Enterprise License** (UEL) — a commercial option available
  from **And The Next GmbH**.

`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL`

Source files carry the license notice in their header; new files must include
it (copy it from any existing source file).

## Recipes

Each recipe under `recipes/` packages third-party software whose own license
governs the produced binary. The catalog's license covers the recipe scaffolding
and pipeline tooling, not the upstream sources a recipe builds.
