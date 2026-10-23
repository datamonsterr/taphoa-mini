#!/usr/bin/env bash
set -euo pipefail
backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
model_dir="${MODEL_DIR:-$backend_dir/models}"
mkdir -p "$model_dir"
# Image Arjun Raj Laboratory's SAM vit_b export, pinned to the uploaded revision.
base_url="https://huggingface.co/rajlab/sam_vit_b/resolve/c20401a6d978ab52ba87b5e05909be65c79b0686"
fetch() {
  local source="$1" destination="$2" checksum="$3"
  if [[ -f "$destination" ]] && echo "$checksum  $destination" | sha256sum --check --status; then
    echo "Already verified: $destination"
  else
    local temporary
    temporary="$(mktemp "$model_dir/.download.XXXXXX")"
    trap 'rm -f "$temporary"' RETURN
    curl --fail --location --retry 3 --connect-timeout 20 "$base_url/$source" --output "$temporary"
    echo "$checksum  $temporary" | sha256sum --check
    mv "$temporary" "$destination"
    trap - RETURN
  fi
  # Public model weights must also be readable by the non-root container user.
  chmod 644 "$destination"
  sha256sum "$destination"
}
fetch encoder.onnx "$model_dir/sam_vit_b_encoder.onnx" 08d1b45ed63bcb74a6504f01392dafd4b39b9c1df657321b914f4bf56b3754c9
fetch decoder.onnx "$model_dir/sam_vit_b_decoder.onnx" 67eeb654773f692dd6c5f5c54c8ea3de3be2790cc293ee3c8d0dee137a7751c7
