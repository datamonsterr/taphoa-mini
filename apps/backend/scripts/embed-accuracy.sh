#!/usr/bin/env bash
# Evaluate external labeled crops at 112 px; see recognition-evidence.md.
set -euo pipefail
backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$#" != 1 || ! -f "$1" ]]; then
  echo "usage: $0 <labeled-manifest.json> (manifest must exist; A1 data is not bundled)" >&2
  exit 2
fi
manifest="$(realpath "$1")"
model="${DINO_MODEL_PATH:-$backend_dir/models/dinov2_small.onnx}"
if [[ ! -f "$model" ]]; then
  echo "DINO model missing: run apps/backend/scripts/fetch-models.sh first" >&2
  exit 2
fi
export ORT_DYLIB_PATH="${ORT_DYLIB_PATH:-$backend_dir/onnxruntime/lib/libonnxruntime.so.1.23.2}"
if [[ ! -f "$ORT_DYLIB_PATH" ]]; then
  echo "ONNX Runtime missing: run apps/backend/scripts/fetch-onnxruntime.sh first" >&2
  exit 2
fi
model="$(realpath "$model")"
export ORT_DYLIB_PATH="$(realpath "$ORT_DYLIB_PATH")"
cd "$backend_dir"
exec cargo run --locked --profile "${ACCURACY_PROFILE:-release}" \
  -p taphoa-recognition --example embed_accuracy -- "$model" "$manifest"
