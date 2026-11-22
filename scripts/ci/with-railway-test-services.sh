#!/usr/bin/env bash
# Run a command against the Railway `test` environment's Postgres, Redis and bucket
# through their public TCP proxies, isolated per run and cleaned up afterwards.
#   with-railway-test-services.sh <command> [args...]
# Needs RAILWAY_TOKEN (project token for `test`) or a linked CLI, plus psql on PATH.
# The caller starts services and owns their lifecycle through cleanup (the two
# workflows share wait_turn.py). This helper only owns its database and Redis db.
# Isolation: a throwaway database `it_<epoch>_<run>_<attempt>_<pid>` on the shared Postgres (dropped on exit)
# and Redis logical database IT_REDIS_DB (default 15, flushed on exit). The bucket is shared and append-only;
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

# A SUCCESS deployment can precede its socket accepting connections. Probe the
# public proxies before maintenance or tests, without printing credentials.
ready=0
for attempt in $(seq 1 30); do
  if PGCONNECT_TIMEOUT=5 psql "$DATABASE_URL" --quiet --command 'SELECT 1' >/dev/null 2>&1 \
    && [ "$(timeout 5s redis-cli -u "$REDIS_URL" --raw PING 2>/dev/null)" = PONG ]; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  echo '::error::Railway test Postgres or Redis did not accept connections' >&2
  exit 1
fi

admin_url="$DATABASE_URL"
run_id="${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-0}_$$"
db_name="it_$(date +%s)_${run_id}"
redis_db="${IT_REDIS_DB:-15}"
redis_base="$REDIS_URL"

cleanup() {
  status=$?
  psql "$admin_url" --quiet --command "DROP DATABASE IF EXISTS \"$db_name\" WITH (FORCE)" >/dev/null 2>&1 \
    || echo "::warning::could not drop database $db_name"
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -u "$redis_base" -n "$redis_db" FLUSHDB >/dev/null 2>&1 || echo "::warning::could not flush Redis db $redis_db"
  fi
  exit "$status"
}
python3 -I "$here/it_database.py"
trap cleanup EXIT

psql "$admin_url" --quiet --command "CREATE DATABASE \"$db_name\""
export DATABASE_URL="${admin_url%/*}/$db_name"
export REDIS_URL="$redis_base/$redis_db"
export S3_CREATE_BUCKET=false
echo "Isolated database $db_name; Redis db $redis_db; bucket ${AWS_S3_BUCKET_NAME:-unset}"

"$@"
