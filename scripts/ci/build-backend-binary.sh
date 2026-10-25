#!/usr/bin/env bash
# Build the release taphoa-api and taphoa-seed binaries inside rust:1-bookworm (the image Dockerfile builds with) so
# they link the same glibc as the debian bookworm runtime image. Output: ci-bin/taphoa-api and ci-bin/taphoa-seed
# (the assistant evaluation seeds its store with taphoa-seed; see scripts/ci/eval-ci.sh).
# Cargo registry and target dirs are bind-mounted from $CACHE_DIR so actions/cache can keep them.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cache="${CACHE_DIR:-$repo/.ci-cache}"
mkdir -p "$cache/cargo" "$cache/target" "$repo/ci-bin"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$repo/apps/backend:/work" -v "$cache/cargo:/usr/local/cargo/registry" -v "$cache/target:/target" \
  -e CARGO_TARGET_DIR=/target -e CARGO_INCREMENTAL=0 -e CARGO_TERM_COLOR=always \
  -w /work "${RUST_IMAGE:-rust:1-bookworm}" \
  sh -c 'cargo build --locked --release --bin taphoa-api --bin taphoa-seed && cp /target/release/taphoa-api /work/taphoa-api.out && cp /target/release/taphoa-seed /work/taphoa-seed.out'
mv "$repo/apps/backend/taphoa-api.out" "$repo/ci-bin/taphoa-api"
mv "$repo/apps/backend/taphoa-seed.out" "$repo/ci-bin/taphoa-seed"
ls -lh "$repo/ci-bin/taphoa-api" "$repo/ci-bin/taphoa-seed"
