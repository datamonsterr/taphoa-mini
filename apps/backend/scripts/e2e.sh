#!/usr/bin/env bash
set -euo pipefail
backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_url="${BASE_URL:-http://localhost:8080}"
work_dir="$(mktemp -d)"
response="$work_dir/response"
trap 'rm -rf "$work_dir"' EXIT
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

# Storage checks are mandatory by default, including in CI.
if [[ "${EXPECT_IMAGES:-1}" != "0" ]]; then
  # Images are store-scoped: create a throwaway store and use its access token.
  check /v1/stores 201 -H 'content-type: application/json' --data '{"store_name":"e2e script","display_name":"Lead","device":{"name":"e2e","platform":"android"}}'
  token="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["access_token"], end="")' "$response")"
  auth=(-H "authorization: Bearer $token")
  check /v1/images 201 "${auth[@]}" --form "image=@$backend_dir/tests/fixtures/sample.png;type=image/png"
  image_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"], end="")' "$response")"
  check "/v1/images/$image_id" 200 "${auth[@]}"
  image_url="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["url"], end="")' "$response")"
  curl --fail --silent --show-error --max-time 30 "$image_url" --output "$work_dir/download.png"
  cmp "$backend_dir/tests/fixtures/sample.png" "$work_dir/download.png"
  echo "PASS presigned image download: identical bytes"
fi
