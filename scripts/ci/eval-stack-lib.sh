#!/usr/bin/env bash
# Steps shared by the assistant evaluation stacks (epic X7): scripts/ci/eval-ci.sh (CI, compose
# Postgres and Redis) and packages/eval/scripts/local-stack.sh (a workstation, the shared dev
# Postgres and Redis). Source it; it defines functions only.
#
# Variables the caller sets before calling:
#   stack_state_dir   directory for backend.pid, backend.log and seed.log
#   stack_backend_port  port the backend listens on
# And, for stack_start_backend, the array stack_backend_env of NAME=value pairs the backend gets
# in addition to PORT, JWT_SECRET and the rate limits.

stack_pid_file() { echo "$stack_state_dir/backend.pid"; }

# stack_port_in_use PORT: succeeds when something already listens on 127.0.0.1:PORT.
stack_port_in_use() { (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null; }

# stack_backend_running: succeeds when the recorded backend process is alive.
stack_backend_running() {
  local pid_file
  pid_file="$(stack_pid_file)"
  [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2> /dev/null
}

# stack_seed SEED_BIN DATABASE_URL [seed flags]: `taphoa-seed --profile eval`. It prints fixture
# credentials, so they go to seed.log and not to the terminal. CLERK_SECRET_KEY and CLERK_API_URL
# reach the seed through the environment (the seed links Clerk test users when X1 is merged).
stack_seed() {
  local seed_bin="$1" database_url="$2"
  shift 2
  mkdir -p "$stack_state_dir"
  echo "==> taphoa-seed --profile eval $*"
  if ! DATABASE_URL="$database_url" "$seed_bin" --profile eval "$@" > "$stack_state_dir/seed.log" 2>&1; then
    echo "taphoa-seed failed; log tail:" >&2
    tail -n 40 "$stack_state_dir/seed.log" >&2
    return 1
  fi
}

# stack_start_backend BACKEND_BIN DATABASE_URL REDIS_URL: starts the backend detached with the
# eval hooks on. ASSISTANT_ALLOW_EVAL_HEADERS lets the harness pin the date and the model per
# request; it belongs to throwaway stacks only, never to a deployed environment.
stack_start_backend() {
  local backend_bin="$1" database_url="$2" redis_url="$3"
  mkdir -p "$stack_state_dir"
  echo "==> backend on :$stack_backend_port ($backend_bin)"
  : > "$stack_state_dir/backend.log"
  env \
    PORT="$stack_backend_port" \
    DATABASE_URL="$database_url" \
    REDIS_URL="$redis_url" \
    JWT_SECRET="eval-only-jwt-secret-0123456789abcdef0123456789abcdef" \
    RATE_LIMIT_STORE_CREATE_PER_HOUR=100000 \
    RATE_LIMIT_JOIN_PER_HOUR=100000 \
    RATE_LIMIT_RECOVER_PER_10MIN=100000 \
    ASSISTANT_ALLOW_EVAL_HEADERS=1 \
    "${stack_backend_env[@]}" \
    setsid nohup "$backend_bin" > "$stack_state_dir/backend.log" 2>&1 < /dev/null &
  echo $! > "$(stack_pid_file)"
}

# stack_wait_ready [SECONDS]: waits for /readyz of the process started above (default 120 s).
# Our own process is checked first: a foreign server on the port must not count as ready.
stack_wait_ready() {
  local seconds="${1:-120}" pid_file url
  pid_file="$(stack_pid_file)"
  url="http://127.0.0.1:$stack_backend_port/readyz"
  for _ in $(seq 1 "$seconds"); do
    if ! kill -0 "$(cat "$pid_file")" 2> /dev/null; then
      echo "backend exited early; log tail:" >&2
      tail -n 40 "$stack_state_dir/backend.log" >&2
      return 1
    fi
    if curl --silent --fail --max-time 3 "$url" > /dev/null; then
      echo "==> ready: $url (pid $(cat "$pid_file"), logs in $stack_state_dir)"
      return 0
    fi
    sleep 1
  done
  echo "backend not ready after $seconds s; log tail:" >&2
  tail -n 40 "$stack_state_dir/backend.log" >&2
  return 1
}

# stack_stop_backend: stops the recorded backend (TERM, then KILL after 10 s).
stack_stop_backend() {
  local pid_file pid
  pid_file="$(stack_pid_file)"
  [[ -f "$pid_file" ]] || return 0
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
}
