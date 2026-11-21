#!/usr/bin/env bash
set -euo pipefail
backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${ORT_INSTALL_DIR:-$backend_dir/onnxruntime}"
version=1.23.2
wheel="onnxruntime-$version-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl"
url="https://files.pythonhosted.org/packages/ef/88/9cc25d2bafe6bc0d4d3c1db3ade98196d5b355c0b273e6a5dc09c5d5d0d5/$wheel"
checksum=0f9b4ae77f8e3c9bee50c27bc1beede83f786fe1d52e99ac85aa8d65a01e9b77
case "${TARGETARCH:-$(uname -m)}" in
  amd64|x86_64) ;;
  *) echo "Unsupported runtime architecture; install ONNX Runtime >=1.23 and set ORT_DYLIB_PATH" >&2; exit 1 ;;
esac
if [[ ! -f "$runtime_dir/lib/libonnxruntime.so.$version" ]]; then
  temporary="$(mktemp -d)"
  trap 'rm -rf "$temporary"' EXIT
  curl --fail --location --retry 3 "$url" --output "$temporary/$wheel"
  echo "$checksum  $temporary/$wheel" | sha256sum --check
  mkdir -p "$runtime_dir/lib"
  unzip -p "$temporary/$wheel" onnxruntime/LICENSE > "$runtime_dir/LICENSE"
  unzip -p "$temporary/$wheel" onnxruntime/ThirdPartyNotices.txt > "$runtime_dir/ThirdPartyNotices.txt"
  unzip -p "$temporary/$wheel" onnxruntime/capi/libonnxruntime.so.$version > "$runtime_dir/lib/libonnxruntime.so.$version"
  if unzip -Z1 "$temporary/$wheel" | grep -qx 'onnxruntime/capi/libonnxruntime_providers_shared.so'; then
    unzip -p "$temporary/$wheel" onnxruntime/capi/libonnxruntime_providers_shared.so > "$runtime_dir/lib/libonnxruntime_providers_shared.so"
  fi
fi
printf 'export ORT_DYLIB_PATH=%q\n' "$runtime_dir/lib/libonnxruntime.so.$version"
