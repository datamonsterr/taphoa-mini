#!/usr/bin/env bash
set -euo pipefail
backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
model_dir="${MODEL_DIR:-$backend_dir/models}"
mkdir -p "$model_dir"

fetch() {
  local url="$1" destination="$2" checksum="$3"
  if [[ -f "$destination" ]] && echo "$checksum  $destination" | sha256sum --check --status; then
    echo "Already verified: $destination"
  else
    local temporary
    temporary="$(mktemp "$model_dir/.download.XXXXXX")"
    trap 'rm -f "$temporary"' RETURN
    curl --fail --location --retry 3 --connect-timeout 20 "$url" --output "$temporary"
    echo "$checksum  $temporary" | sha256sum --check
    mv "$temporary" "$destination"
    trap - RETURN
  fi
  # Public model weights must also be readable by the non-root container user.
  chmod 644 "$destination"
  sha256sum "$destination"
}

# MobileSAM (TinyViT encoder, SAM mask decoder), ONNX export by Acly, pinned revision.
# The ViT-B export it replaces needed ~20 s per 1600 px photo on 4 CPU cores; see
# docs/specs/recognition-latency.md.
sam_url="https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8"
fetch "$sam_url/mobile_sam_image_encoder.onnx" "$model_dir/mobile_sam_image_encoder.onnx" 580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749
fetch "$sam_url/sam_mask_decoder_multi.onnx" "$model_dir/sam_mask_decoder_multi.onnx" 8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe

# DINOv2 ViT-S/14 (384-d), transformers ONNX export from onnx-community, pinned revision.
dino_url="https://huggingface.co/onnx-community/dinov2-small/resolve/8b1f705a3a7f6f062f6bdd21986c1583d3ef105d"
fetch "$dino_url/onnx/model.onnx" "$model_dir/dinov2_small.onnx" f22797eabf810a75e41de68d378541ebea372122b25c4ce3ef25ff618250c20a
