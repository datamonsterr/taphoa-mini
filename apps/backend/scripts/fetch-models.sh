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

# Apache-2.0: VietOCR by pbcquoc; PP-OCRv6 detection export via RapidOCR.
# ONNX exports: https://github.com/duchoa1297/vietocr-onnx/releases/tag/ocr-v1
ocr_url="https://github.com/duchoa1297/vietocr-onnx/releases/download/ocr-v1"
fetch "$ocr_url/det.onnx" "$model_dir/ocr_det.onnx" 090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f
fetch "$ocr_url/vietocr_encoder.onnx" "$model_dir/ocr_vietocr_encoder.onnx" 7375c11ad23d52547a344ec5f53adf89db8302f035ceb3f1e67cff2c04069ae7
fetch "$ocr_url/vietocr_decoder.onnx" "$model_dir/ocr_vietocr_decoder.onnx" 73b92cd370563952b345703ecdce84d8374a9f0a7018afee062170efe04f21f5
fetch "$ocr_url/vietocr.json" "$model_dir/ocr_vietocr.json" 518345b7672fd36e534fb8ffcf6f6599c687793541259170834789fe2f7dd6e6
