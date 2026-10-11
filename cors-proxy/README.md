# nano CORS proxy (Tier 1.5)

A tiny Cloudflare Worker that adds the `Access-Control-*` headers a target omits,
so a browser-hosted nano guest can reach CORS-blocked services (GitHub's git
endpoints, most public APIs). It is **HTTP(S)-only** — far narrower than a TCP
relay — so the abuse/liability surface is small. Self-host it; never make any
relay a hosted dependency of the catalog.

This is the fallback the network bridge (`/dev/__net__`) retries through when a
**direct** `fetch` is CORS-blocked.

## Deploy

```sh
cd catalog/cors-proxy
npx wrangler login
npx wrangler deploy        # → https://nano-cors-proxy.<account>.workers.dev
```

The proxy **fails closed** until configured. Set these Worker vars in
`wrangler.toml` `[vars]` before deploying (a `wrangler deploy` overwrites
dashboard-set vars with the file's values):

| var | meaning |
|---|---|
| `ALLOWED_ORIGINS` | Comma-separated browser Origins allowed to call the proxy, exact match (e.g. `https://userland.run,https://www.userland.run`). **Empty → every request gets 403.** The request Origin is never reflected unless it is on this list. |
| `FORWARD_AUTHORIZATION` | `"true"` forwards the caller's `Authorization` header upstream — needed for private-repo clones and `git push` over HTTPS. Default `"false"`. Only enable on a proxy you operate: the operator can see those credentials. It is never forwarded to a different host after a redirect. |

Target hosts are fixed in the `ALLOW` list in `worker.js`; keep it to the exact
hostnames you intend to proxy. An empty `ALLOW` refuses every target.

## Wire it into the bridge

Point the network bridge at the deployed Worker:

```js
const vm = await NanoVM.create({ wasm, ramMB });
vm.setNetwork({ corsProxyUrl: "https://nano-cors-proxy.<account>.workers.dev" });
```

The bridge tries a direct `fetch(url)` first; only on a CORS/network failure does
it retry as `fetch(corsProxyUrl + "?apiurl=" + encodeURIComponent(url))`. So
CORS-open targets never touch the proxy — it's a pure fallback.

## Request shape

```
GET https://<worker>/?apiurl=<url-encoded target>
```

- **Targets:** `https://` only, host on `ALLOW` (subdomains included), no
  `user:pass@` in the URL.
- **Methods:** `GET`/`HEAD` to any allowed target; `POST` only to git smart-HTTP
  endpoints (`…/git-upload-pack` for clone/fetch, `…/git-receive-pack` for push).
  Everything else → 405.
- **Request headers:** only a fixed allow-list is forwarded — `Accept`,
  `Accept-Language`, `Content-Type`, `Content-Encoding`, `Git-Protocol`,
  `User-Agent`, `Range`, `If-None-Match`, `If-Modified-Since` (+ `Authorization`
  when `FORWARD_AUTHORIZATION=true`). `Cookie`, `Origin`, `X-Forwarded-*` and
  everything else are dropped.
- **Redirects** are followed manually (at most 5 hops); every hop must again be
  `https` + `ALLOW`ed, otherwise the request fails with 403.
- `OPTIONS` preflight answers with the fixed method/header lists above (never
  echoed from the request). Responses carry `Access-Control-Allow-Origin` set to
  the (allow-listed) requesting origin; upstream `Set-Cookie` is stripped.

## Limits (browser sandbox, not nano)

- HTTP(S) only — no raw TCP/UDP, so no ssh/ping through this path (that's Tier 2,
  Tailscale, a separate deliberate decision).
- The proxy operator sees the proxied URLs and bytes — host it yourself or point
  at a trusted one; never send credentials through a proxy you don't control.
