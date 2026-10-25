#!/usr/bin/env bash
# Helpers for the assistant evaluation in CI (epic X7): the assistant-eval-smoke job in ci.yml
# and the nightly workflow eval.yml share them, so both bring up the same stack.
#
#   eval-ci.sh mode            Decide live or stub; writes mode= to $GITHUB_OUTPUT.
#                              Env: EVAL_FORK_PR ("true" for a pull request from a fork),
#                              EVAL_HAVE_SECRETS ("true" when the OpenRouter and Clerk secrets
#                              are set), EVAL_ASSISTANT_DIR (override, for tests).
#   eval-ci.sh up              Start the live stack: compose postgres + redis (project
#                              taphoa-eval), `taphoa-seed --profile eval`, then the backend
#                              with the eval hooks on; wait for /readyz. Appends BACKEND_URL
#                              and EVAL_DATABASE_URL to $GITHUB_ENV.
#                              Env: OPENROUTER_API_KEY (required), CLERK_SECRET_KEY,
#                              CLERK_PUBLISHABLE_KEY, BACKEND_BIN, SEED_BIN, EVAL_STATE_DIR,
#                              EVAL_BACKEND_PORT, EVAL_POSTGRES_PORT, EVAL_REDIS_PORT.
#   eval-ci.sh down            Stop the backend and remove the compose project.
#   eval-ci.sh summary <dir>   Append the *.md files of <dir> to $GITHUB_STEP_SUMMARY
#                              (stdout when unset), capped below the 1 MiB step limit.
#
# No model weights or object storage are needed: the assistant only talks to Postgres, Redis
# and OpenRouter.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
state_dir="${EVAL_STATE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/taphoa-eval-stack}"
pid_file="$state_dir/backend.pid"
project=taphoa-eval

backend_port="${EVAL_BACKEND_PORT:-8080}"
export POSTGRES_PORT="${EVAL_POSTGRES_PORT:-55632}"
export REDIS_PORT="${EVAL_REDIS_PORT:-56679}"

compose() { docker compose -p "$project" -f "$repo/docker-compose.yml" "$@"; }

mode() {
  local assistant_dir="${EVAL_ASSISTANT_DIR:-$repo/apps/backend/crates/api/src/assistant}"
  local chosen=stub reason
  if [[ ! -d "$assistant_dir" ]]; then
    reason="the assistant (epic X3) is not in this checkout"
  elif [[ "${EVAL_FORK_PR:-}" == "true" ]]; then
    reason="pull request from a fork, so no secrets"
  elif [[ "${EVAL_HAVE_SECRETS:-}" != "true" ]]; then
    reason="the OpenRouter or Clerk secrets are not available"
  else
    chosen=live
    reason="the assistant is in this checkout and the secrets are available"
  fi
  echo "eval mode: $chosen ($reason)"
  echo "mode=$chosen" >> "${GITHUB_OUTPUT:-/dev/stdout}"
}

up() {
  if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
    echo "OPENROUTER_API_KEY is not set: the assistant cannot answer without it" >&2
    exit 1
  fi
  local backend_bin="${BACKEND_BIN:-$repo/ci-bin/taphoa-api}"
  local seed_bin="${SEED_BIN:-$repo/ci-bin/taphoa-seed}"
  for bin in "$backend_bin" "$seed_bin"; do
    [[ -x "$bin" ]] || { echo "binary not executable: $bin" >&2; exit 1; }
  done
  mkdir -p "$state_dir"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2> /dev/null; then
    echo "backend already running (pid $(cat "$pid_file")); run 'down' first" >&2
    exit 1
  fi
  if (exec 3<> "/dev/tcp/127.0.0.1/$backend_port") 2> /dev/null; then
    echo "port $backend_port is already in use; set EVAL_BACKEND_PORT to a free port" >&2
    exit 1
  fi

  echo "==> postgres, redis (compose project $project)"
  compose up -d --wait --wait-timeout 180 postgres redis
  local database_url="postgres://taphoa:taphoa@127.0.0.1:$POSTGRES_PORT/taphoa"

  # The seed prints its fixture credentials; keep them in a log file, not in the job log.
  echo "==> taphoa-seed --profile eval"
  if ! DATABASE_URL="$database_url" "$seed_bin" --profile eval > "$state_dir/seed.log" 2>&1; then
    echo "taphoa-seed failed; log tail:" >&2
    tail -n 40 "$state_dir/seed.log" >&2
    exit 1
  fi

  # ASSISTANT_ALLOW_EVAL_HEADERS lets the harness pin the date and the model per request. It
  # belongs to this throwaway stack only, never to a deployed environment.
  local secret_env=()
  for name in OPENROUTER_API_KEY CLERK_SECRET_KEY CLERK_PUBLISHABLE_KEY; do
    if [[ -n "${!name:-}" ]]; then secret_env+=("$name=${!name}"); fi
  done
  echo "==> backend on :$backend_port ($backend_bin)"
  : > "$state_dir/backend.log"
  env \
    PORT="$backend_port" \
    DATABASE_URL="$database_url" \
    REDIS_URL="redis://127.0.0.1:$REDIS_PORT" \
    JWT_SECRET="eval-only-jwt-secret-0123456789abcdef0123456789abcdef" \
    RATE_LIMIT_STORE_CREATE_PER_HOUR=100000 \
    RATE_LIMIT_JOIN_PER_HOUR=100000 \
    RATE_LIMIT_RECOVER_PER_10MIN=100000 \
    ASSISTANT_ALLOW_EVAL_HEADERS=1 \
    "${secret_env[@]}" \
    setsid nohup "$backend_bin" > "$state_dir/backend.log" 2>&1 < /dev/null &
  echo $! > "$pid_file"

  local url="http://127.0.0.1:$backend_port/readyz"
  for _ in $(seq 1 120); do
    # Check our own process first: a foreign server on the port must not count as ready.
    if ! kill -0 "$(cat "$pid_file")" 2> /dev/null; then
      echo "backend exited early; log tail:" >&2
      tail -n 40 "$state_dir/backend.log" >&2
      exit 1
    fi
    if curl --silent --fail --max-time 3 "$url" > /dev/null; then
      echo "==> ready: $url (pid $(cat "$pid_file"), logs in $state_dir)"
      {
        echo "BACKEND_URL=http://127.0.0.1:$backend_port"
        echo "EVAL_DATABASE_URL=$database_url"
      } >> "${GITHUB_ENV:-/dev/null}"
      return 0
    fi
    sleep 1
  done
  echo "backend not ready after 120 s; log tail:" >&2
  tail -n 40 "$state_dir/backend.log" >&2
  exit 1
}

down() {
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2> /dev/null; then
      kill "$pid" 2> /dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2> /dev/null || break
        sleep 0.5
      done
      kill -9 "$pid" 2> /dev/null || true
    fi
    rm -f "$pid_file"
  fi
  compose down -v --remove-orphans
}

summary() {
  local dir="${1:?results directory required}"
  local out="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
  # GitHub rejects a step summary above 1 MiB; stay below it.
  local budget=900000 size
  local files=()
  if [[ -d "$dir" ]]; then
    for file in "$dir"/*.md; do
      if [[ -f "$file" ]]; then files+=("$file"); fi
    done
  fi
  if ((${#files[@]} == 0)); then
    echo "No results file was written." >> "$out"
    return 0
  fi
  for file in "${files[@]}"; do
    size="$(wc -c < "$file")"
    if ((size < budget)); then
      cat "$file" >> "$out"
      echo >> "$out"
      budget=$((budget - size - 1))
    else
      # iconv -c drops a UTF-8 sequence cut in half by head -c.
      head -c "$budget" "$file" | iconv -c -f UTF-8 -t UTF-8 >> "$out"
      printf '\n\n_Cut at the step summary limit; the uploaded artifact has the full file._\n' >> "$out"
      break
    fi
  done
}

case "${1:-}" in
  mode) mode ;;
  up) up ;;
  down) down ;;
  summary) summary "${2:-}" ;;
  *)
    echo "usage: $0 mode | up | down | summary <results-dir>" >&2
    exit 2
    ;;
esac
