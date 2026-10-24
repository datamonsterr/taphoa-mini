#!/usr/bin/env bash
# Real-backend stack for the web/Android E2E suites: postgres + redis + storage in docker compose
# (project taphoa-e2e, so it never touches another stack) and the taphoa-api binary on the host
# with SAM + DINO models loaded.
#
#   scripts/e2e/stack.sh up     start everything and wait for /readyz
#   scripts/e2e/stack.sh down   stop the backend and remove containers and volumes
#
# Environment (all optional):
#   BACKEND_BIN          prebuilt taphoa-api (CI); otherwise `cargo build --release` runs
#   E2E_BACKEND_PORT     backend port (default 8080; listens on 0.0.0.0 so the Android
#                        emulator can reach it as 10.0.2.2)
#   E2E_POSTGRES_PORT    default 55532
#   E2E_REDIS_PORT       default 56579
#   E2E_STORAGE_PORT     default 9100
#   E2E_PUBLIC_HOST      host in presigned image URLs (default localhost; 10.0.2.2 for the emulator)
#   E2E_STATE_DIR        pid and log directory (default <repo>/.e2e-stack, gitignored)
#   E2E_SKIP_MODELS=1    start without SAM/DINO (recognition returns 503)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
backend_dir="$repo/apps/backend"
state_dir="${E2E_STATE_DIR:-$repo/.e2e-stack}"
pid_file="$state_dir/backend.pid"
log_file="$state_dir/backend.log"
project=taphoa-e2e

backend_port="${E2E_BACKEND_PORT:-8080}"
export POSTGRES_PORT="${E2E_POSTGRES_PORT:-55532}"
export REDIS_PORT="${E2E_REDIS_PORT:-56579}"
export STORAGE_PORT="${E2E_STORAGE_PORT:-9100}"

compose() { docker compose -p "$project" -f "$repo/docker-compose.yml" "$@"; }

up() {
  mkdir -p "$state_dir"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "backend already running (pid $(cat "$pid_file")); run 'down' first" >&2
    exit 1
  fi

  echo "==> postgres, redis, storage (compose project $project)"
  compose up -d --wait --wait-timeout 180 postgres redis storage

  local bin="${BACKEND_BIN:-}"
  if [[ -z "$bin" ]]; then
    echo "==> cargo build --release (set BACKEND_BIN to skip)"
    (cd "$backend_dir" && cargo build --locked --release --bin taphoa-api)
    local target
    target="$(cd "$backend_dir" && cargo metadata --format-version 1 --no-deps | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
    bin="$target/release/taphoa-api"
  fi
  [[ -x "$bin" ]] || { echo "backend binary not executable: $bin" >&2; exit 1; }

  local model_env=()
  if [[ "${E2E_SKIP_MODELS:-0}" != "1" ]]; then
    echo "==> ONNX Runtime and model weights (cached under apps/backend)"
    # fetch-onnxruntime.sh prints an `export ORT_DYLIB_PATH=...` line on stdout, after the
    # checksum result on a first download; keep only the export line.
    eval "$("$backend_dir/scripts/fetch-onnxruntime.sh" | grep '^export ORT_DYLIB_PATH=')"
    "$backend_dir/scripts/fetch-models.sh" > /dev/null
    local models="${MODEL_DIR:-$backend_dir/models}"
    model_env=(
      ORT_DYLIB_PATH="$ORT_DYLIB_PATH"
      SAM_ENCODER_PATH="$models/mobile_sam_image_encoder.onnx"
      SAM_DECODER_PATH="$models/sam_mask_decoder_multi.onnx"
      DINO_MODEL_PATH="$models/dinov2_small.onnx"
    )
  fi

  if (exec 3<> "/dev/tcp/127.0.0.1/$backend_port") 2> /dev/null; then
    echo "port $backend_port is already in use; set E2E_BACKEND_PORT to a free port" >&2
    exit 1
  fi

  echo "==> backend on :$backend_port ($bin)"
  : > "$log_file"
  env \
    PORT="$backend_port" \
    DATABASE_URL="postgres://taphoa:taphoa@127.0.0.1:$POSTGRES_PORT/taphoa" \
    REDIS_URL="redis://127.0.0.1:$REDIS_PORT" \
    JWT_SECRET="${JWT_SECRET:-e2e-only-jwt-secret-0123456789abcdef0123456789abcdef}" \
    RATE_LIMIT_STORE_CREATE_PER_HOUR=100000 \
    RATE_LIMIT_JOIN_PER_HOUR=100000 \
    RATE_LIMIT_RECOVER_PER_10MIN=100000 \
    AWS_ENDPOINT_URL="http://127.0.0.1:$STORAGE_PORT" \
    AWS_ACCESS_KEY_ID=taphoa-local \
    AWS_SECRET_ACCESS_KEY=taphoa-local-secret \
    AWS_S3_BUCKET_NAME=images \
    AWS_DEFAULT_REGION=us-east-1 \
    S3_FORCE_PATH_STYLE=true \
    S3_CREATE_BUCKET=true \
    S3_PUBLIC_ENDPOINT_URL="http://${E2E_PUBLIC_HOST:-localhost}:$STORAGE_PORT" \
    RUST_LOG="${RUST_LOG:-info}" \
    "${model_env[@]}" \
    setsid nohup "$bin" > "$log_file" 2>&1 < /dev/null &
  echo $! > "$pid_file"

  local url="http://127.0.0.1:$backend_port/readyz"
  for _ in $(seq 1 120); do
    # Check our own process first: a foreign server on the port must not count as ready.
    if ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      echo "backend exited early; log tail:" >&2
      tail -n 40 "$log_file" >&2
      exit 1
    fi
    if curl --silent --fail --max-time 3 "$url" > /dev/null; then
      echo "==> ready: $url (pid $(cat "$pid_file"), log $log_file)"
      return 0
    fi
    sleep 1
  done
  echo "backend not ready after 120 s; log tail:" >&2
  tail -n 40 "$log_file" >&2
  exit 1
}

down() {
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
  compose down -v --remove-orphans
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
