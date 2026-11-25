#!/usr/bin/env bash
# Wait until <base-url>/healthz reports service_version <expected>: wait-version.sh <base-url> <expected>
# Right after a deploy the edge can briefly answer from a replica that is still switching over, so
# a single read is not enough. Env: WAIT_ATTEMPTS (default 18), WAIT_INTERVAL seconds (default 10).
set -euo pipefail
base="${1:?base url required}"
base="${base%/}"
expected="${2:?expected version required}"
attempts="${WAIT_ATTEMPTS:-18}"
interval="${WAIT_INTERVAL:-10}"
body=''
for attempt in $(seq 1 "$attempts"); do
  body="$(curl --silent --max-time 10 "$base/healthz" || true)"
  actual="$(jq -r '.service_version // empty' <<<"$body" 2>/dev/null || true)"
  echo "GET $base/healthz attempt $attempt: service_version=${actual:-none}"
  if [ "$actual" = "$expected" ]; then
    exit 0
  fi
  sleep "$interval"
done
echo "::error::$base serves ${actual:-no version}, expected $expected; last body: ${body:0:300}"
exit 1
