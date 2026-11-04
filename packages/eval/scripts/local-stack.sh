#!/usr/bin/env bash
# Local assistant evaluation stack (epic X7): the eval store in your own database plus a backend
# with the eval hooks on and the real OpenRouter provider. See "Local stack" in the package README.
#
#   local-stack.sh up       Build taphoa-api and taphoa-seed, create the database, run
#                           `taphoa-seed --profile eval --reset`, flush the Redis database,
#                           start the backend on a free port, wait for /readyz and print the
#                           exports to source.
#   local-stack.sh env      Print the same exports for the running stack.
#   local-stack.sh status   Say whether the backend runs and answers /readyz.
#   local-stack.sh down     Stop the backend, drop the database and flush the Redis database.
#
# Environment (all optional):
#   EVAL_SECRETS_FILE       File with OPENROUTER_EVAL_API_KEY, CLERK_SECRET_KEY,
#                           CLERK_PUBLISHABLE_KEY (default ~/.config/taphoa-mini/secrets.env).
#                           Variables already set win over the file. Values are never printed.
#   EVAL_STACK_PG_URL       Postgres server (default postgres://taphoa:taphoa@localhost:55432).
#   EVAL_STACK_DB           Database name (default taphoa_eval_local). `down` drops it.
#   EVAL_STACK_REDIS_URL    Redis with a numbered database (default redis://localhost:56379/7).
#                           `up` and `down` flush that database, so keep it to this stack.
#   EVAL_BACKEND_PORT       Backend port (default: the first free one from 18080).
#   EVAL_STACK_STATE_DIR    Pid, logs and port (default ~/.cache/taphoa-eval-local-stack).
#   EVAL_STACK_KEEP_DB      Set to 1 to keep the database on `down`.
#   CARGO_TARGET_DIR        Build output (default apps/backend/target of this checkout).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
# shellcheck source=scripts/ci/eval-stack-lib.sh
source "$repo/scripts/ci/eval-stack-lib.sh"

stack_state_dir="${EVAL_STACK_STATE_DIR:-$HOME/.cache/taphoa-eval-local-stack}"
stack_backend_env=()
state_file="$stack_state_dir/stack.env"
pg_url="${EVAL_STACK_PG_URL:-postgres://taphoa:taphoa@localhost:55432}"
pg_url="${pg_url%/}"
db_name="${EVAL_STACK_DB:-taphoa_eval_local}"
redis_url="${EVAL_STACK_REDIS_URL:-redis://localhost:56379/7}"
store_id="${EVAL_STORE_ID:-e7a10e7a-0000-4000-8000-000000000000}"

db() { node "$here/stack-db.mjs" "$@"; }

# Load the secrets file without letting it override variables that are already set.
load_secrets() {
  local file="${EVAL_SECRETS_FILE:-$HOME/.config/taphoa-mini/secrets.env}" line name value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value%\"}"
    value="${value#\"}"
    if [[ -z "${!name:-}" ]]; then export "$name=$value"; fi
  done < "$file"
}

pick_port() {
  if [[ -n "${EVAL_BACKEND_PORT:-}" ]]; then
    echo "$EVAL_BACKEND_PORT"
    return
  fi
  local port
  for port in $(seq 18080 18180); do
    if ! stack_port_in_use "$port"; then
      echo "$port"
      return
    fi
  done
  echo "no free port between 18080 and 18180" >&2
  return 1
}

print_exports() {
  local port
  port="$(sed -n 's/^PORT=//p' "$state_file")"
  echo "export BACKEND_URL=http://127.0.0.1:$port"
  echo "export EVAL_DATABASE_URL=$pg_url/$db_name"
  echo "export EVAL_STORE_ID=$store_id"
  echo "# Also needed for live runs (never printed): OPENROUTER_EVAL_API_KEY for the quota guard"
  echo "# and the judge, CLERK_SECRET_KEY once Clerk identity (epic X1) is on main. Load them with:"
  echo "#   set -a; source ${EVAL_SECRETS_FILE:-$HOME/.config/taphoa-mini/secrets.env}; set +a"
}

up() {
  load_secrets
  if [[ -z "${OPENROUTER_EVAL_API_KEY:-}" ]]; then
    echo "OPENROUTER_EVAL_API_KEY is not set (export it or put it in the secrets file)" >&2
    exit 1
  fi
  mkdir -p "$stack_state_dir"
  if stack_backend_running; then
    echo "backend already running (pid $(cat "$(stack_pid_file)")); run 'down' first" >&2
    exit 1
  fi

  echo "==> cargo build taphoa-api taphoa-seed"
  cargo build --manifest-path "$repo/apps/backend/Cargo.toml" -p taphoa-api \
    --bin taphoa-api --bin taphoa-seed 2>&1 | tail -n 5
  local bin_dir="${CARGO_TARGET_DIR:-$repo/apps/backend/target}/debug"
  local backend_bin="$bin_dir/taphoa-api" seed_bin="$bin_dir/taphoa-seed"
  for bin in "$backend_bin" "$seed_bin"; do
    [[ -x "$bin" ]] || { echo "binary not found after the build: $bin" >&2; exit 1; }
  done

  stack_backend_port="$(pick_port)"
  echo "==> database $db_name, redis $(sed 's#//[^@/]*@#//#' <<< "$redis_url")"
  db create "$pg_url/postgres" "$db_name"
  db flush-redis "$redis_url"
  # --reset rebuilds the eval store from nothing, so reruns start from the same fixtures.
  stack_seed "$seed_bin" "$pg_url/$db_name" --reset || exit 1

  # The provider is the real OpenRouter one; models come from .env.example (the same list the
  # deployed environments start from). Secrets are handed over only when set.
  local models
  models="${ASSISTANT_MODELS:-$(sed -n 's/^ASSISTANT_MODELS=//p' "$repo/.env.example" | head -n 1)}"
  stack_backend_env=(ASSISTANT_MODEL_PROVIDER=openrouter "OPENROUTER_API_KEY=$OPENROUTER_EVAL_API_KEY")
  if [[ -n "$models" ]]; then stack_backend_env+=("ASSISTANT_MODELS=$models"); fi
  for name in CLERK_SECRET_KEY CLERK_PUBLISHABLE_KEY CLERK_API_URL; do
    if [[ -n "${!name:-}" ]]; then stack_backend_env+=("$name=${!name}"); fi
  done
  stack_start_backend "$backend_bin" "$pg_url/$db_name" "$redis_url"
  printf 'PORT=%s\nDB=%s\n' "$stack_backend_port" "$db_name" > "$state_file"
  if ! stack_wait_ready 120; then
    stack_stop_backend
    exit 1
  fi
  echo
  print_exports
}

status() {
  if ! stack_backend_running; then
    echo "stopped"
    return 1
  fi
  local port
  port="$(sed -n 's/^PORT=//p' "$state_file")"
  if curl --silent --fail --max-time 3 "http://127.0.0.1:$port/readyz" > /dev/null; then
    echo "running: http://127.0.0.1:$port (pid $(cat "$(stack_pid_file)"), database $db_name)"
  else
    echo "process running (pid $(cat "$(stack_pid_file)")) but /readyz does not answer; see $stack_state_dir/backend.log"
    return 1
  fi
}

down() {
  stack_stop_backend
  rm -f "$state_file"
  if [[ "${EVAL_STACK_KEEP_DB:-}" == "1" ]]; then
    echo "database $db_name kept"
  else
    db drop "$pg_url/postgres" "$db_name"
  fi
  db flush-redis "$redis_url"
}

case "${1:-}" in
  up) up ;;
  env)
    [[ -f "$state_file" ]] || { echo "the stack is not up" >&2; exit 1; }
    print_exports
    ;;
  status) status ;;
  down) down ;;
  *)
    echo "usage: $0 up | env | status | down" >&2
    exit 2
    ;;
esac
