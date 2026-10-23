#!/usr/bin/env bash
# Wait until <base-url>/healthz and /readyz answer 200: wait-healthy.sh <base-url>
# Env: WAIT_ATTEMPTS (default 30), WAIT_INTERVAL seconds (default 10).
set -euo pipefail
base="${1:?base url required}"
base="${base%/}"
attempts="${WAIT_ATTEMPTS:-30}"
interval="${WAIT_INTERVAL:-10}"
for path in /healthz /readyz; do
  ok=0
  for attempt in $(seq 1 "$attempts"); do
    code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "$base$path" || true)"
    echo "GET $base$path attempt $attempt: HTTP $code"
    if [ "$code" = "200" ]; then
      ok=1
      break
    fi
    sleep "$interval"
  done
  if [ "$ok" != "1" ]; then
    echo "::error::$base$path did not return 200 after $attempts attempts"
    exit 1
  fi
done
