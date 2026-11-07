#!/usr/bin/env bash
set -euo pipefail
backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cache="${EVAL_CACHE_DIR:-$backend_dir/.cache/eval}"
revision=fc80ba90f803d79d0383df52c5a4ac5de99ff6fc
checksum=1e985fb2f13163de9b2b61fa5fc911f9a9d1bc082249135506a7274c7ccd59d5
archive="$cache/dataset-$revision.tar.gz"
mkdir -p "$cache"
if ! echo "$checksum  $archive" | sha256sum --check --status; then
  temporary="$(mktemp "$cache/.dataset.XXXXXX")"
  trap 'rm -f "$temporary"' EXIT
  curl --fail --location --retry 3 --connect-timeout 20 "https://codeload.github.com/marcusklasson/GroceryStoreDataset/tar.gz/$revision" -o "$temporary"
  echo "$checksum  $temporary" | sha256sum --check >&2
  mv "$temporary" "$archive"
  trap - EXIT
fi
output="$cache/GroceryStoreDataset-$revision"
if [[ ! -f "$output/.complete" ]]; then
  mkdir -p "$output"
  tar -xzf "$archive" --strip-components=1 -C "$output"
  touch "$output/.complete"
fi
printf '%s\n' "$output/dataset"
