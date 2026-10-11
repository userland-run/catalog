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
//
// Everything here FAILS CLOSED:
//   - Callers: only browser Origins listed in env ALLOWED_ORIGINS (comma-separated,
//     exact match, e.g. "https://userland.run,https://www.userland.run"). Unset or
//     empty → every request is refused. The Origin is never reflected otherwise.
//   - Targets: https only, host must be in ALLOW below (empty ALLOW → refuse all).
//     Redirects are followed manually (max MAX_HOPS) and every hop is re-checked.
//   - Methods: GET/HEAD anywhere; POST only to git smart-HTTP endpoints
//     (…/git-upload-pack = clone/fetch, …/git-receive-pack = push).
//   - Headers: only FORWARD_HEADERS go upstream (no Cookie, no X-Forwarded-*, no
//     Origin). Authorization is forwarded ONLY when env FORWARD_AUTHORIZATION is
//     "true" (needed for private-repo clone / push) and only to the original host.

// Allow-list of target hostnames the proxy will forward to. KEEP THIS TIGHT — an
// open proxy is an abuse magnet. Subdomains of a listed host are allowed. An
// empty array refuses every target.
const ALLOW = [
  "github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "api.github.com",
  "gitlab.com",
];

// Request headers forwarded upstream (lower-case). Everything else is dropped.
// content-encoding + git-protocol are required by git smart-HTTP (gzip'd
// upload-pack bodies, protocol v2).
const FORWARD_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "content-encoding",
  "git-protocol",
  "user-agent",
  "range",
  "if-none-match",
  "if-modified-since",
];

const MAX_HOPS = 5;
const ALLOWED_METHODS = "GET,HEAD,POST,OPTIONS";
const GIT_POST_PATH = /\/git-(upload|receive)-pack$/;

function hostAllowed(host) {
  return ALLOW.some((h) => host === h || host.endsWith("." + h));
}

function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Validate a target URL: https + allow-listed host. Returns an error string or null.
function checkTarget(u) {
  if (u.protocol !== "https:") return "only https targets";
  if (u.username || u.password) return "credentials in URL not allowed";
  if (!hostAllowed(u.hostname)) return `host not allowed: ${u.hostname}`;
  return null;
}

function corsHeaders(origin) {
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const origins = allowedOrigins(env);

    // Caller check first: no allow-listed Origin → no CORS headers, no proxying.
    if (!origin || !origins.includes(origin)) {
      return new Response("nano-cors: origin not allowed", { status: 403 });
    }
    const cors = corsHeaders(origin);
    const forwardAuth = String(env?.FORWARD_AUTHORIZATION || "").toLowerCase() === "true";
    const allowHeaders = [...FORWARD_HEADERS, ...(forwardAuth ? ["authorization"] : [])].join(",");

    // CORS preflight: a fixed method/header list (never echoed from the request).
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": ALLOWED_METHODS,
          "Access-Control-Allow-Headers": allowHeaders,
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const deny = (status, msg) => new Response(`nano-cors: ${msg}`, { status, headers: cors });

    const target = url.searchParams.get("apiurl");
    if (!target) return deny(400, "missing ?apiurl=");
    let t;
    try { t = new URL(target); } catch { return deny(400, "bad apiurl"); }
    const bad = checkTarget(t);
    if (bad) return deny(t.protocol !== "https:" ? 400 : 403, bad);

    const method = request.method;
    if (method === "POST") {
      if (!GIT_POST_PATH.test(t.pathname)) return deny(405, "POST is only allowed to git-upload-pack / git-receive-pack");
    } else if (method !== "GET" && method !== "HEAD") {
      return deny(405, `method not allowed: ${method}`);
    }

    // Fixed header allow-list.
    const fwdHeaders = new Headers();
    for (const h of FORWARD_HEADERS) {
      const v = request.headers.get(h);
      if (v !== null) fwdHeaders.set(h, v);
    }
    const auth = forwardAuth ? request.headers.get("Authorization") : null;
    if (auth) fwdHeaders.set("Authorization", auth);

    // Buffer the body once so a 307/308 hop can resend it.
    let body = method === "POST" ? await request.arrayBuffer() : undefined;
    let curMethod = method;
    const originalHost = t.host;

    // Follow redirects manually, re-validating every hop against the allow-list.
    let resp;
    for (let hop = 0; ; hop++) {
      try {
        resp = await fetch(t.toString(), { method: curMethod, headers: fwdHeaders, body, redirect: "manual" });
      } catch (e) {
        return deny(502, `upstream fetch failed: ${e?.message ?? e}`);
      }
      const loc = resp.headers.get("Location");
      if (![301, 302, 303, 307, 308].includes(resp.status) || !loc) break;
      if (hop >= MAX_HOPS) return deny(508, `too many redirects (>${MAX_HOPS})`);
      let next;
      try { next = new URL(loc, t); } catch { return deny(502, "bad redirect Location"); }
      const nextBad = checkTarget(next);
      if (nextBad) return deny(403, `redirect refused (${nextBad})`);
      // Fetch-spec method rewrite: 303 (and 301/302 for POST) become GET, no body.
      if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && curMethod === "POST")) {
        if (curMethod !== "HEAD") curMethod = "GET";
        body = undefined;
        fwdHeaders.delete("content-type");
        fwdHeaders.delete("content-encoding");
      }
      // Never carry credentials to a different host.
      if (next.host !== originalHost) fwdHeaders.delete("Authorization");
      t = next;
    }

    // Re-emit with CORS for the (allow-listed) requesting origin; never pass
    // upstream cookies back to the browser.
    const out = new Response(resp.body, resp);
    out.headers.delete("Set-Cookie");
    out.headers.set("Access-Control-Allow-Origin", origin);
    out.headers.append("Vary", "Origin");
    out.headers.set("Access-Control-Expose-Headers", "*");
    return out;
  },
};
