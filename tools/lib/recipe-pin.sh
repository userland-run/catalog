# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
# Copyright (C) 2026 And The Next GmbH - https://userland.run
#
# Supply-chain pinning helpers for recipes/*/build.sh. Source it from a recipe:
#
#   cd "$(dirname "$0")"
#   . ../../tools/lib/recipe-pin.sh
#
# Every upstream input is pinned to content, not to a mutable name:
#   clone_pinned  <repo> <tag> <commit-sha> <dest>   tag clone + HEAD must equal the commit
#   fetch_sha256  <url> <out> <sha256>               download + sha256 must match
#   ensure_cargo_zigbuild                            exact cargo-zigbuild version, --locked
#   lock_snapshot / lock_assert_pruned_only          for recipes that must patch
#                                                    Cargo.toml (so `--locked` can't be
#                                                    used): the lockfile may only LOSE
#                                                    entries, never gain or change one.
# A mismatch is a hard failure — re-pin deliberately (update the SHA/SHA256 in
# the recipe, e.g. from `git ls-remote <repo> refs/tags/<tag>^{}`) after review.

CARGO_ZIGBUILD_VERSION="0.23.0"

_pin_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# clone_pinned <repo> <tag> <commit-sha> <dest>
clone_pinned() {
  local repo="$1" tag="$2" want="$3" dest="$4" got
  if ! [[ "$want" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: clone_pinned $repo@$tag: expected a 40-hex commit sha, got '$want'" >&2; return 1
  fi
  rm -rf "$dest"
  git -c advice.detachedHead=false clone --depth 1 --branch "$tag" "$repo" "$dest"
  got="$(git -C "$dest" rev-parse HEAD)"
  if [ "$got" != "$want" ]; then
    echo "ERROR: $repo tag $tag resolves to $got, pinned $want — upstream tag moved; refusing to build" >&2
    return 1
  fi
  echo "pinned: $repo@$tag = $got"
}

# fetch_sha256 <url> <out> <sha256>
fetch_sha256() {
  local url="$1" out="$2" want="$3" got
  if ! [[ "$want" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: fetch_sha256 $url: expected a 64-hex sha256, got '$want'" >&2; return 1
  fi
  curl -fsSL --retry 3 "$url" -o "$out"
  got="$(_pin_sha256 "$out")"
  if [ "$got" != "$want" ]; then
    rm -f "$out"
    echo "ERROR: sha256 mismatch for $url: got $got, pinned $want" >&2
    return 1
  fi
  echo "verified: $url sha256=$got"
}

# Install the pinned cargo-zigbuild unless exactly that version is already present.
ensure_cargo_zigbuild() {
  if command -v cargo-zigbuild >/dev/null 2>&1 \
     && cargo-zigbuild --version 2>/dev/null | grep -qw "$CARGO_ZIGBUILD_VERSION"; then
    return 0
  fi
  cargo install --locked --version "$CARGO_ZIGBUILD_VERSION" cargo-zigbuild
}

# lock_snapshot [dir]  — remember the upstream Cargo.lock before patching.
lock_snapshot() { cp "${1:-.}/Cargo.lock" "${1:-.}/.Cargo.lock.upstream"; }

# lock_assert_pruned_only [dir]  — after the build: the lockfile may only have
# dropped packages (the patched-out dependency); any added/changed line fails.
lock_assert_pruned_only() {
  local d="${1:-.}" added
  added="$(diff -U0 "$d/.Cargo.lock.upstream" "$d/Cargo.lock" | grep -E '^\+[^+]' || true)"
  if [ -n "$added" ]; then
    echo "ERROR: Cargo.lock gained/changed entries vs upstream (deps not pinned):" >&2
    echo "$added" >&2
    return 1
  fi
  echo "Cargo.lock: only pruned entries vs upstream (all remaining deps pinned)"
}
