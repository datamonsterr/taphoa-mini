#!/usr/bin/env bash
# End-to-end run against a deployed backend.
#   BACKEND_URL        required; base URL, no trailing path
#   E2E_DIR            suite directory (default packages/e2e, created by epic E1)
#   LATENCY_P95_MS     hot-endpoint p95 budget in ms (default 200)
#   LATENCY_SAMPLES    samples per latency probe (default 20)
# When the suite exists it runs through pnpm (`pnpm --filter @taphoa/e2e test`); until then a
# notice is emitted and a smoke check plus latency probe runs so the pipeline stays meaningful.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
if [ -z "${BACKEND_URL:-}" ]; then
  echo "BACKEND_URL must be set" >&2
  exit 1
fi
base="${BACKEND_URL%/}"
suite="${E2E_DIR:-$repo/packages/e2e}"
samples="${LATENCY_SAMPLES:-20}"
budget="${LATENCY_P95_MS:-200}"

if [ -f "$suite/package.json" ]; then
  echo "Running e2e suite in $suite against $base"
  export BACKEND_URL="$base"
  export LATENCY_P95_MS="$budget"
  script="$(node -e 'const s=require(process.argv[1]).scripts||{};console.log(s["test:e2e"]?"test:e2e":"test")' "$suite/package.json")"
  (cd "$repo" && pnpm --filter @taphoa/e2e run "$script")
else
  echo "::notice::packages/e2e not present yet; running smoke and latency probes only."
  WAIT_ATTEMPTS=3 WAIT_INTERVAL=5 bash "$here/wait-healthy.sh" "$base"
fi

echo "Latency probes (budget p95 <= ${budget}ms)"
for path in /healthz /readyz; do
  python3 -I "$here/latency_check.py" "$base" "$path" "$samples" "$budget"
done
