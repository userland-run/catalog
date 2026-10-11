# Catalog signing keys

`catalog.pub` is the **production Ed25519 public key** (raw 32 bytes, base64)
the client verifies every manifest and index against. The matching **private
key** is never committed — it lives only as the GitHub Actions secret
`CATALOG_ED25519_PRIVATE_KEY` (base64 PKCS8 DER), reachable only by the `publish`
job on `push` to `main`. That separation is the trust boundary: untrusted PRs can
never sign.

The SDK pins the same key as `CATALOG_PUBLIC_KEY_B64` in
`sdk/src/catalog/pubkey.ts`; the two must stay identical. This is enforced by
`tools/check-pubkey.mjs` — in CI by `.github/workflows/key-sync.yml` and as a
pre-publish step in `publish.yml` (both check out `userland-run/sdk@main`), and
locally with `npm run check-pubkey` when `../sdk` is checked out next to this
repo. `publish.mjs` additionally refuses to sign if the signing secret does not
match `catalog.pub`.

## Rotating / provisioning

Rotation produces exactly **one** keypair:

```bash
node tools/gen-keypair.mjs ~/catalog-signing.key
#  → writes the private key to ~/catalog-signing.key (mode 0600; refuses to
#    overwrite, refuses paths inside this repo)
#  → writes keys/catalog.pub and prints the public key on stdout
```

Then:

1. Store the contents of `~/catalog-signing.key` as the catalog repo secret
   `CATALOG_ED25519_PRIVATE_KEY`, then delete the file.
2. Put the printed public key into `CATALOG_PUBLIC_KEY_B64` in
   `sdk/src/catalog/pubkey.ts` and release the SDK.
3. Commit `keys/catalog.pub`. For the **first publish after rotation**, set
   the repo variable `CATALOG_PREV_PUBLIC_KEY` (the old raw base64 public key; unset it afterwards) so
   `publish.mjs` can still verify the previous generation it carries forward; app
   manifests signed by the old key keep verifying in clients only if they also
   trust it, so re-package (dispatch `publish.yml` with `recipes: "*"`) to re-sign
   everything under the new key.
