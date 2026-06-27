// nfetch — a tiny HTTP client that talks the nano network bridge.
//
// The nano container exposes a host-brokered fetch through the sentinel device
// `/dev/__net__` (see nano/container/nanovm.mjs: `__net__`, `_doNetFetch`,
// `_httpResp`). The protocol, on a single O_RDWR fd:
//
//   1. open("/dev/__net__", O_RDWR)
//   2. write a request: "<METHOD> <URL>\n<Header>: <v>\n...\n\n<body>"
//      (head and body are separated by a blank line, i.e. "\n\n")
//   3. read back an HTTP/1.1 response framed by the host:
//        "HTTP/1.1 <status> <text>\r\n<headers>\r\ncontent-length: N\r\n\r\n<body>"
//      Reads keep returning chunks until EOF (read() == 0).
//
// nfetch issues "GET <url>\n\n", reads the whole response, strips everything up
// to the "\r\n\r\n" head terminator, and prints the body to stdout. `-i` prints
// the full response (head + body) instead. std-only; builds to a static
// riscv64gc-musl ELF.

use std::env;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::process::exit;

const NET_DEVICE: &str = "/dev/__net__";
const HEAD_SEP: &[u8] = b"\r\n\r\n";

fn main() {
    // argv: nfetch [-i|--include] <url> [METHOD]
    let mut include_headers = false;
    let mut positional: Vec<String> = Vec::new();
    for arg in env::args().skip(1) {
        match arg.as_str() {
            "-i" | "--include" => include_headers = true,
            "-h" | "--help" => {
                eprintln!("usage: nfetch [-i] <url> [method]");
                exit(0);
            }
            _ => positional.push(arg),
        }
    }

    let url = match positional.first() {
        Some(u) => u.clone(),
        None => {
            eprintln!("usage: nfetch [-i] <url> [method]");
            exit(2);
        }
    };
    let method = positional
        .get(1)
        .map(|m| m.to_uppercase())
        .unwrap_or_else(|| "GET".to_string());

    // Request framing: "<METHOD> <URL>\n\n" (no extra headers, empty body).
    let request = format!("{} {}\n\n", method, url);

    // A single O_RDWR fd: write the request, then read the response off it.
    let mut dev = match OpenOptions::new().read(true).write(true).open(NET_DEVICE) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("nfetch: cannot open {}: {}", NET_DEVICE, e);
            exit(1);
        }
    };
    if let Err(e) = dev.write_all(request.as_bytes()) {
        eprintln!("nfetch: write to {} failed: {}", NET_DEVICE, e);
        exit(1);
    }

    let mut response = Vec::new();
    if let Err(e) = dev.read_to_end(&mut response) {
        eprintln!("nfetch: read from {} failed: {}", NET_DEVICE, e);
        exit(1);
    }

    // Split off the HTTP head at the first CRLF-CRLF. Without `-i` we emit only
    // the body; if the terminator is missing we fall back to the raw response.
    let body_start = find(&response, HEAD_SEP).map(|i| i + HEAD_SEP.len());
    let out_bytes: &[u8] = match body_start {
        Some(i) if !include_headers => &response[i..],
        _ => &response[..],
    };

    let stdout = io::stdout();
    let mut w = stdout.lock();
    if w.write_all(out_bytes).and_then(|_| w.flush()).is_err() {
        exit(1);
    }
}

/// First index of `needle` within `haystack` (naive scan; responses are small).
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}
