#!/usr/bin/env bash
set -euo pipefail
backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${ORT_INSTALL_DIR:-$backend_dir/onnxruntime}"
version=1.23.2
case "${TARGETARCH:-$(uname -m)}" in
  amd64|x86_64) arch=x64; checksum=1fa4dcaef22f6f7d5cd81b28c2800414350c10116f5fdd46a2160082551c5f9b ;;
  *) echo "Unsupported runtime architecture; install ONNX Runtime >=1.23 and set ORT_DYLIB_PATH" >&2; exit 1 ;;
esac
if [[ ! -f "$runtime_dir/lib/libonnxruntime.so.$version" ]]; then
  temporary="$(mktemp -d)"
  trap 'rm -rf "$temporary"' EXIT
  curl --fail --location --retry 3 "https://github.com/microsoft/onnxruntime/releases/download/v$version/onnxruntime-linux-$arch-$version.tgz" --output "$temporary/runtime.tgz"
  echo "$checksum  $temporary/runtime.tgz" | sha256sum --check
  mkdir -p "$runtime_dir"
  tar xzf "$temporary/runtime.tgz" --strip-components=1 -C "$runtime_dir"
fi
printf 'export ORT_DYLIB_PATH=%q\n' "$runtime_dir/lib/libonnxruntime.so.$version"
