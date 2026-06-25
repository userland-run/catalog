# Catalog signing keys

`catalog.pub` is the **Ed25519 public key** (raw 32 bytes, base64) the client
verifies every manifest and index against. The matching **private key** is never
committed — it lives only as the GitHub Actions secret
`CATALOG_ED25519_PRIVATE_KEY` (base64 PKCS8 DER), reachable only by the `publish`
job on `push` to `main`. That separation is the trust boundary: untrusted PRs can
never sign.

The SDK ships a copy of this public key (`sdk/src/catalog/catalog.pub`); the two
must stay in sync.

## Rotating / provisioning

Generate a fresh keypair (this overwrites `catalog.pub` and prints the private
key to stdout — store that as the CI secret, never in git):

```bash
node tools/gen-keypair.mjs > /dev/null   # writes keys/catalog.pub
# re-run without redirect to capture the private key line for the secret
```

> ⚠️ The committed `catalog.pub` is currently a **development placeholder**.
> Before going live, regenerate the keypair, set the CI secret, copy the new
> public key into `sdk/src/catalog/catalog.pub`, and bump the catalog generation.
