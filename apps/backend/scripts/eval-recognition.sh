#!/usr/bin/env bash
set -euo pipefail
backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
limit="${EVAL_TEST_PER_CLASS:-4}"
while (($#)); do
  case "$1" in
    --max-test-per-class)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || { echo 'Expected a positive integer after --max-test-per-class' >&2; exit 2; }
      limit="$2"
      shift 2
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
cache="${EVAL_CACHE_DIR:-$backend_dir/.cache/eval}"
export EVAL_CACHE_DIR="$cache"
mkdir -p "$cache" "$backend_dir/eval/results"
dataset="$($backend_dir/scripts/eval-dataset.sh)"
if [[ -z "${DINO_MODEL_PATH:-}" ]]; then
  MODEL_DIR="$cache/models" "$backend_dir/scripts/fetch-models.sh" >&2
  DINO_MODEL_PATH="$cache/models/dinov2_small.onnx"
fi
if [[ -z "${ORT_DYLIB_PATH:-}" ]]; then
  ORT_INSTALL_DIR="$cache/onnxruntime" "$backend_dir/scripts/fetch-onnxruntime.sh" >&2
  ORT_DYLIB_PATH="$cache/onnxruntime/lib/libonnxruntime.so.1.23.2"
fi
export ORT_DYLIB_PATH
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
cd "$backend_dir"
cargo build --locked --release -p taphoa-api --example recognition_eval
binary="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')/release/examples/recognition_eval"
stamp="${EVAL_DATE:-$(date -u +%F)}"
report="$(mktemp "$cache/.report.XXXXXX")"
trap 'rm -f "$report"' EXIT
"$binary" "$dataset" "$DINO_MODEL_PATH" "$cache" "$limit" > "$report"
mv "$report" "$backend_dir/eval/results/$stamp-recognition.md"
trap - EXIT
cp "$cache/result.json" "$backend_dir/eval/results/$stamp-recognition.json"
