// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
//
// Tier-1.5 CORS proxy for the nano network bridge. A browser guest's host fetch
// is CORS-bound; for targets that send no CORS headers (github's git endpoints,
// most public APIs) the bridge retries through this Worker, which adds the
// missing Access-Control-* headers. Narrower than a TCP relay — HTTP(S) only,
// no arbitrary sockets — so the liability surface stays small. Self-host it
// (wrangler deploy) and point the bridge at it: nano.setNetwork({ corsProxyUrl }).
//
// Request shape (matches the bridge): GET https://<worker>/?apiurl=<encoded URL>

// Allow-list of target hostnames the proxy will forward to. KEEP THIS TIGHT for a
// public deployment — an open proxy is an abuse magnet. Empty array = allow all
// (DEV ONLY). Subdomains of a listed host are allowed.
const ALLOW = [
  "github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "api.github.com",
  "gitlab.com",
];

const CORS_BASE = {
  "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function hostAllowed(host) {
  if (ALLOW.length === 0) return true; // dev: open
  return ALLOW.some((h) => host === h || host.endsWith("." + h));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";
    const target = url.searchParams.get("apiurl");

    // CORS preflight: echo the requested headers, allow the requesting origin.
    if (request.method === "OPTIONS") {
      const reqHeaders = request.headers.get("Access-Control-Request-Headers");
      return new Response(null, {
        headers: {
          ...CORS_BASE,
          "Access-Control-Allow-Origin": origin,
          ...(reqHeaders ? { "Access-Control-Allow-Headers": reqHeaders } : {}),
          Vary: "Origin",
        },
      });
    }

    if (!target) return new Response("nano-cors: missing ?apiurl=", { status: 400 });
    let t;
    try { t = new URL(target); } catch { return new Response("nano-cors: bad apiurl", { status: 400 }); }
    if (t.protocol !== "https:" && t.protocol !== "http:") {
      return new Response("nano-cors: only http(s) targets", { status: 400 });
    }
    if (!hostAllowed(t.hostname)) {
      return new Response(`nano-cors: host not allowed: ${t.hostname}`, { status: 403 });
    }

    // Forward to the target. Set Origin to the target's own origin so its
    // same-site / CORS checks pass; drop hop-by-hop headers.
    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.set("Origin", t.origin);
    fwdHeaders.delete("Host");
    const fwd = new Request(t.toString(), {
      method: request.method,
      headers: fwdHeaders,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "follow",
    });

    let resp;
    try {
      resp = await fetch(fwd);
    } catch (e) {
      return new Response(`nano-cors: upstream fetch failed: ${e?.message ?? e}`, {
        status: 502,
        headers: { "Access-Control-Allow-Origin": origin, Vary: "Origin" },
      });
    }

    // Re-emit with permissive CORS for the requesting origin.
    const out = new Response(resp.body, resp);
    out.headers.set("Access-Control-Allow-Origin", origin);
    out.headers.append("Vary", "Origin");
    out.headers.set("Access-Control-Expose-Headers", "*");
    return out;
  },
};
