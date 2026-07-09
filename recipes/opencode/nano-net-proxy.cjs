// SPDX-License-Identifier: AGPL-3.0-only
// nano-net-proxy.cjs — in-guest loopback→/dev/__net__ HTTP proxy (a `--require`
// preload, so it lives INSIDE the app's process: the VM serializes fork, so a
// separate proxy process would contend with the app).
//
// The guest has no outbound TCP; the only egress is the /dev/__net__ device:
// write "<METHOD> <absolute-url>\n<Header: v>...\n\n<body>" to the fd, then
// read the framed HTTP/1.1 response off the same fd until EOF. In-VM loopback
// sockets DO work, so this preload listens on 127.0.0.1 and forwards each
// request to NANO_NET_TARGET over the device. The app just points its base URL
// at http://127.0.0.1:8787 — zero code changes in the app.
//
// Routing is the local/cloud switch:
//   NANO_NET_TARGET=http://nanoinfer.internal   → the in-browser WebGPU model
//   NANO_NET_TARGET=https://api.openai.com      → real cloud (host corsProxyUrl)
//   NANO_PROXY_PORT=8787                        → listen port
//
// readSync blocks the event loop while a response streams, so SSE arrives at
// the loopback client in one burst when the upstream finishes — functionally
// identical for an agent loop, just not incremental.
"use strict";
const fs = require("fs");
const http = require("http");

const TARGET = (process.env.NANO_NET_TARGET || "http://nanoinfer.internal").replace(/\/+$/, "");
const PORT = Number(process.env.NANO_PROXY_PORT || 8787);

// Hop-by-hop / re-framed headers we must not forward in either direction.
// accept-encoding out + content-encoding back: the host fetch already
// decompresses, so a forwarded content-encoding would make the client
// gunzip plain text.
const REQ_SKIP = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding", "keep-alive", "expect"]);
const RES_SKIP = new Set(["content-length", "transfer-encoding", "connection", "content-encoding", "keep-alive"]);

function forward(req, res, body) {
  let fd;
  try {
    fd = fs.openSync("/dev/__net__", "r+");
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "no /dev/__net__ bridge: " + e.message, type: "nano_proxy_error" } }));
    return;
  }
  try {
    let head = `${req.method} ${TARGET}${req.url}\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      if (REQ_SKIP.has(name.toLowerCase())) continue;
      head += `${name}: ${req.rawHeaders[i + 1]}\n`;
    }
    head += "\n";
    // One write with the full message, like the proven llm-demo protocol.
    fs.writeSync(fd, Buffer.concat([Buffer.from(head, "utf8"), body]));

    const buf = Buffer.alloc(65536);
    let acc = Buffer.alloc(0);
    let headerDone = false;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length); // blocks until the next chunk
      if (n === 0) break; // EOF — upstream finished
      if (!headerDone) {
        acc = Buffer.concat([acc, buf.subarray(0, n)]);
        const end = acc.indexOf("\r\n\r\n");
        if (end < 0) continue;
        const headText = acc.subarray(0, end).toString("utf8");
        const lines = headText.split("\r\n");
        const m = /^HTTP\/\d\.\d (\d{3})\s*(.*)$/.exec(lines[0]) || [null, "502", "Bad Gateway"];
        const headers = {};
        for (let i = 1; i < lines.length; i++) {
          const c = lines[i].indexOf(":");
          if (c < 0) continue;
          const name = lines[i].slice(0, c).trim();
          if (RES_SKIP.has(name.toLowerCase())) continue;
          headers[name] = lines[i].slice(c + 1).trim();
        }
        res.writeHead(Number(m[1]), m[2] || undefined, headers);
        const rest = acc.subarray(end + 4);
        if (rest.length) res.write(rest);
        headerDone = true;
      } else {
        res.write(Buffer.from(buf.subarray(0, n))); // copy: buf is reused
      }
    }
    if (!headerDone) {
      // Upstream never produced an HTTP head (device error text or empty).
      res.writeHead(502, { "content-type": "text/plain" });
      if (acc.length) res.write(acc);
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(e && e.message || e), type: "nano_proxy_error" } }));
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => forward(req, res, Buffer.concat(chunks)));
  req.on("error", () => { try { res.destroy(); } catch { /* gone */ } });
});
server.on("error", (e) => {
  // EADDRINUSE: another instance in this VM already proxies — that one wins.
  if (e.code !== "EADDRINUSE") console.error("[nano-net-proxy]", e.message);
});
server.listen(PORT, "127.0.0.1", () => {
  if (process.env.NANO_PROXY_QUIET !== "1")
    console.error(`[nano-net-proxy] 127.0.0.1:${PORT} -> ${TARGET}`);
});
server.unref(); // never keep a short-lived CLI alive just for the proxy
