#!/usr/bin/env bash
# Checks the HTTP contract of the landing Caddy image (apps/landing/Caddyfile).
# Usage: bash apps/landing/scripts/check-headers.sh http://127.0.0.1:8080
set -euo pipefail

base="${1:?usage: check-headers.sh <base-url>}"
base="${base%/}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Returns the value of header $1 (case-insensitive) from the header dump in $2.
header_value() {
  printf '%s\n' "$2" | tr -d '\r' | grep -i "^$1:" | head -n 1 | sed -E 's/^[^:]*:[[:space:]]*//' || true
}

status_of() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

# The container may still be starting, so wait for /healthz for up to 30 seconds.
for _ in $(seq 1 30); do
  if [ "$(status_of "$base/healthz")" = "200" ]; then break; fi
  sleep 1
done

[ "$(status_of "$base/healthz")" = "200" ] || fail "/healthz did not return 200"
echo "ok: /healthz 200"

index_headers=$(curl -s -D - -o /dev/null "$base/")
index_body=$(curl -s "$base/")
[ "$(printf '%s\n' "$index_headers" | head -n 1 | tr -d '\r' | awk '{print $2}')" = "200" ] || fail "/ did not return 200"
[ "$(header_value cache-control "$index_headers")" = "no-cache" ] || fail "/ cache-control is not no-cache"
printf '%s' "$index_body" | grep -q 'taphoa-api-url' || fail "/ body lacks the taphoa-api-url meta tag"
[ "$(header_value x-content-type-options "$index_headers")" = "nosniff" ] || fail "/ lacks x-content-type-options nosniff"
[ "$(header_value referrer-policy "$index_headers")" = "strict-origin-when-cross-origin" ] || fail "/ lacks the referrer-policy header"
[ -z "$(header_value server "$index_headers")" ] || fail "/ still sends a server header"
echo "ok: / 200, no-cache, body, security headers"

css_path=$(printf '%s' "$index_body" | grep -oE 'href="[^"]*\.[0-9a-f]{8}\.css"' | head -n 1 | sed -E 's/^href="//; s/"$//' || true)
[ -n "$css_path" ] || fail "/ references no content-hashed stylesheet"
css_headers=$(curl -s -D - -o /dev/null "$base/${css_path#/}")
[ "$(header_value cache-control "$css_headers")" = "public, max-age=31536000, immutable" ] \
  || fail "hashed stylesheet $css_path is not cached immutable"
echo "ok: $css_path is immutable"

gzip_headers=$(curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' "$base/")
[ "$(header_value content-encoding "$gzip_headers")" = "gzip" ] || fail "/ with Accept-Encoding gzip is not gzip-encoded"
echo "ok: gzip content-encoding"

[ "$(status_of "$base/nope")" = "404" ] || fail "/nope did not return 404"
echo "ok: /nope 404"

echo "All landing header checks passed."
