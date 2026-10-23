#!/usr/bin/env bash
set -euo pipefail
backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_url="${BASE_URL:-http://localhost:8080}"
response="$(mktemp)"
trap 'rm -f "$response"' EXIT
check() {
  local path="$1" expected="$2"
  shift 2
  local status
  status="$(curl --silent --show-error --max-time 180 --output "$response" --write-out '%{http_code}' "$@" "$base_url$path")"
  if [[ "$status" != "$expected" ]]; then
    echo "FAIL $path: expected $expected, got $status" >&2
    cat "$response" >&2
    exit 1
  fi
  echo "PASS $path: $status $(cat "$response")"
}
check /healthz 200
check /readyz 200
# The default exercises actual inference. Explicitly expect 503 for SKIP_MODELS images.
check /v1/segment "${EXPECT_SEGMENT_STATUS:-${SEGMENT_EXPECTED_STATUS:-200}}" --form "image=@$backend_dir/tests/fixtures/sample.png;type=image/png"
