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

Before deploying publicly, **tighten the `ALLOW` allow-list** in `worker.js` to the
exact target hostnames you intend to proxy. An empty `ALLOW` array allows any
origin (DEV ONLY) — an open proxy is an abuse magnet.

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

- `OPTIONS` preflight is answered with the requested method/headers echoed back.
- The proxy sets the upstream `Origin` to the target's own origin (defeating its
  cross-site check) and re-emits the response with `Access-Control-Allow-Origin`
  set to the requesting origin.

## Limits (browser sandbox, not nano)

- HTTP(S) only — no raw TCP/UDP, so no ssh/ping through this path (that's Tier 2,
  Tailscale, a separate deliberate decision).
- The proxy operator sees the proxied URLs and bytes — host it yourself or point
  at a trusted one; never send credentials through a proxy you don't control.
