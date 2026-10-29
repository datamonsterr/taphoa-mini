#!/usr/bin/env bash
# Smoke checks against a running backend (docker compose in CI).
#   BASE_URL                backend base URL (default http://localhost:8080)
#   EXPECT_SEGMENT_STATUS   expected /v1/segment status (default 200; 503 for SKIP_MODELS images)
#   EXPECT_IMAGES           0 skips the image checks (default 1)
#   CLERK_SECRET_KEY        Clerk Backend API key of the instance the backend trusts. Store
#                           creation and the image round trip need a Clerk session token: the
#                           script creates a throwaway Clerk user (+clerk_test email), mints a
#                           10 minute session token and deletes the user on exit. When unset
#                           (forks, dependabot) only those authenticated checks are skipped.
#   CLERK_API_URL           Backend API base URL (default https://api.clerk.com)
# The key and the token are never printed; keep `set -x` off.
set -euo pipefail
backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_url="${BASE_URL:-http://localhost:8080}"
clerk_api="${CLERK_API_URL:-https://api.clerk.com}"
clerk_api="${clerk_api%/}"
work_dir="$(mktemp -d)"
response="$work_dir/response"
clerk_user_id=""

cleanup() {
  local status=$?
  if [[ -n "$clerk_user_id" ]]; then
    clerk DELETE "/v1/users/$clerk_user_id" > /dev/null \
      || echo "WARN: could not delete Clerk user $clerk_user_id; the +clerk_test sweep removes it later" >&2
  fi
  rm -rf "$work_dir"
  exit "$status"
}
trap cleanup EXIT

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

json_field() {
  python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]], end="")' "$1" "$2"
}

# clerk METHOD PATH [JSON]: Clerk Backend API call, response body in $response. The key goes
# through a header file so it never appears in a process list. A development instance allows
# 100 requests per 10 s for every holder of the key, so a 429 is retried after Retry-After.
clerk() {
  local method="$1" path="$2" body="${3:-}" attempt status wait_s
  local args=(--silent --show-error --max-time 30 --request "$method" --output "$response"
    --dump-header "$work_dir/clerk-headers" --write-out '%{http_code}' --header "@$work_dir/clerk-auth")
  if [[ -n "$body" ]]; then
    args+=(--header 'content-type: application/json' --data "$body")
  fi
  for attempt in 1 2 3 4; do
    status="$(curl "${args[@]}" "$clerk_api$path")"
    if [[ "$status" == "429" && "$attempt" -lt 4 ]]; then
      wait_s="$(sed -n 's/^[Rr]etry-[Aa]fter: *\([0-9][0-9]*\).*/\1/p' "$work_dir/clerk-headers" | head -n 1)"
      sleep "$(( ${wait_s:-2} > 10 ? 10 : ${wait_s:-2} ))"
      continue
    fi
    break
  done
  if [[ "$status" != 2* ]]; then
    echo "FAIL Clerk $method $path: HTTP $status" >&2
    head -c 500 "$response" >&2 || true
    echo >&2
    return 1
  fi
}

# Creates a Clerk user and a session, mints a session token and leaves it in $work_dir/auth as a
# curl header file. $clerk_user_id is set as soon as the user exists so the exit trap deletes it.
mint_clerk_token() {
  printf 'authorization: Bearer %s\n' "$CLERK_SECRET_KEY" > "$work_dir/clerk-auth"
  local suffix session_id
  suffix="$(python3 -I -c 'import secrets; print(secrets.token_hex(6), end="")')"
  clerk POST /v1/users "{\"email_address\":[\"e2e-smoke-${suffix}+clerk_test@example.com\"],\"skip_password_requirement\":true}"
  clerk_user_id="$(json_field "$response" id)"
  clerk POST /v1/sessions "{\"user_id\":\"$clerk_user_id\"}"
  session_id="$(json_field "$response" id)"
  clerk POST "/v1/sessions/$session_id/tokens" '{"expires_in_seconds":600}'
  printf 'authorization: Bearer %s\n' "$(json_field "$response" jwt)" > "$work_dir/auth"
}

check /healthz 200
check /readyz 200
# Segmentation needs a signed-in store member, so an anonymous call must be refused before any inference.
check /v1/segment 401 --form "image=@$backend_dir/tests/fixtures/sample.png;type=image/png"

# Storage checks are mandatory by default, including in CI. They are store-scoped, so they need a
# Clerk session token; without the Clerk secret key (fork and dependabot runs) they are skipped.
if [[ "${EXPECT_IMAGES:-1}" != "0" ]]; then
  if [[ -z "${CLERK_SECRET_KEY:-}" ]]; then
    echo "::notice::CLERK_SECRET_KEY is not set (fork or dependabot run); skipping the authenticated checks: store creation and the image round trip."
  else
    mint_clerk_token
    auth=(-H "@$work_dir/auth")
    # createStore needs only the Clerk token. The new store is the user's single membership, so
    # the image calls need no X-Store-Id header.
    check /v1/stores 201 "${auth[@]}" -H 'content-type: application/json' --data '{"store_name":"e2e script","display_name":"Lead"}'
    # The default exercises actual inference. Explicitly expect 503 for SKIP_MODELS images.
    check /v1/segment "${EXPECT_SEGMENT_STATUS:-${SEGMENT_EXPECTED_STATUS:-200}}" "${auth[@]}" --form "image=@$backend_dir/tests/fixtures/sample.png;type=image/png"
    check /v1/images 201 "${auth[@]}" --form "image=@$backend_dir/tests/fixtures/sample.png;type=image/png"
    image_id="$(json_field "$response" id)"
    check "/v1/images/$image_id" 200 "${auth[@]}"
    image_url="$(json_field "$response" url)"
    curl --fail --silent --show-error --max-time 30 "$image_url" --output "$work_dir/download.png"
    cmp "$backend_dir/tests/fixtures/sample.png" "$work_dir/download.png"
    echo "PASS presigned image download: identical bytes"
  fi
fi
