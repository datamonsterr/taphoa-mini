#!/usr/bin/env bash
# Build the release taphoa-api binary inside rust:<channel>-bookworm so it links the same
# glibc as the debian bookworm runtime image. Output: ci-bin/taphoa-api.
# Cargo registry and target dirs are bind-mounted from $CACHE_DIR so actions/cache can keep them.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cache="${CACHE_DIR:-$repo/.ci-cache}"
channel="$(python3 -I -c 'import tomllib;print(tomllib.load(open("'"$repo"'/rust-toolchain.toml","rb"))["toolchain"]["channel"])')"
mkdir -p "$cache/cargo" "$cache/target" "$repo/ci-bin"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$repo/apps/backend:/work" -v "$cache/cargo:/usr/local/cargo/registry" -v "$cache/target:/target" \
  -e CARGO_TARGET_DIR=/target -e CARGO_INCREMENTAL=0 -e CARGO_TERM_COLOR=always \
  -w /work "rust:${channel}-bookworm" \
  sh -c 'cargo build --locked --release --bin taphoa-api && cp /target/release/taphoa-api /work/taphoa-api.out'
mv "$repo/apps/backend/taphoa-api.out" "$repo/ci-bin/taphoa-api"
ls -lh "$repo/ci-bin/taphoa-api"
