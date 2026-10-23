#!/usr/bin/env bash
# Run a command against the Railway `test` environment's Postgres, Redis and bucket
# through their public TCP proxies, isolated per run and cleaned up afterwards.
#   with-railway-test-services.sh <command> [args...]
# Needs RAILWAY_TOKEN (project token for `test`) or a linked CLI, plus psql on PATH.
# Isolation: a throwaway database `it_<run>` on the shared Postgres (dropped on exit)
# and Redis logical database 15 (flushed on exit). The bucket is shared and append-only;
# tests must use unique object keys.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
environment="${RAILWAY_ENVIRONMENT_NAME:-test}"

if [ "$#" -eq 0 ]; then
  echo "usage: with-railway-test-services.sh <command> [args...]" >&2
  exit 2
fi

# Secrets are masked by railway_env.py before they are exported.
while IFS='=' read -r key value; do
  [ -n "$key" ] && export "$key=$value"
done < <(python3 -I "$here/railway_env.py" "$environment")

admin_url="$DATABASE_URL"
run_id="${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-0}_$$"
db_name="it_${run_id}"
redis_base="$REDIS_URL"

cleanup() {
  status=$?
  psql "$admin_url" --quiet --command "DROP DATABASE IF EXISTS \"$db_name\" WITH (FORCE)" >/dev/null 2>&1 \
    || echo "::warning::could not drop database $db_name"
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -u "$redis_base" -n 15 FLUSHDB >/dev/null 2>&1 || echo "::warning::could not flush Redis db 15"
  fi
  exit "$status"
}
trap cleanup EXIT

psql "$admin_url" --quiet --command "CREATE DATABASE \"$db_name\""
export DATABASE_URL="${admin_url%/*}/$db_name"
export REDIS_URL="$redis_base/15"
export S3_CREATE_BUCKET=false
echo "Isolated database $db_name; Redis db 15; bucket ${AWS_S3_BUCKET_NAME:-unset}"

"$@"
