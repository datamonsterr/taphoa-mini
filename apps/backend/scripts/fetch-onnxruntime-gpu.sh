#!/usr/bin/env bash
# No root or Python environment needed; pinned wheels supply only native libraries.
# Run through ~/.cache/taphoa-mini/heavy (over 1 GB of downloads).
set -euo pipefail
runtime_dir="${ORT_GPU_INSTALL_DIR:-$HOME/.local/share/taphoa-infer/runtime}"
case "${TARGETARCH:-$(uname -m)}" in
  amd64|x86_64) ;;
  *) echo 'GPU runtime supports Linux x86_64 only' >&2; exit 1 ;;
esac
[[ $(uname -s) == Linux ]] || { echo 'Linux required' >&2; exit 1; }
mkdir -p "$runtime_dir"
# Serialize concurrent installs; each package is extracted before its marker is written.
exec 9>"$runtime_dir/.install.lock"
flock 9
temporary="$(mktemp -d "$runtime_dir/.fetch.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT
while read -r package version checksum url; do
  marker="$runtime_dir/.$package-$version-$checksum"
  [[ -f "$marker" ]] && continue
  wheel="$temporary/${url##*/}"
  curl --fail --location --retry 3 "$url" --output "$wheel"
  echo "$checksum  $wheel" | sha256sum --check
  # Retain upstream licenses along with the libraries. Never install Python code.
  python3 - "$wheel" "$runtime_dir" <<'PY'
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as z:
    for name in z.namelist():
        p = pathlib.PurePosixPath(name)
        if p.is_absolute() or '..' in p.parts:
            raise ValueError('unsafe wheel member')
        if name.endswith('/'):
            continue
        if ('.so' in p.name and (name.startswith('nvidia/') or name.startswith('onnxruntime/capi/'))
                or 'LICENSE' in p.name or 'ThirdPartyNotices' in p.name):
            dest = root / p
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(z.read(name))
PY
  touch "$marker"
  rm "$wheel"
done <<'PINS'
onnxruntime-gpu 1.23.2 4f2d1f720685d729b5258ec1b36dee1de381b8898189908c98cbeecdb2f2b5c2 https://files.pythonhosted.org/packages/6c/d9/b7140a4f1615195938c7e358c0804bb84271f0d6886b5cbf105c6cb58aae/onnxruntime_gpu-1.23.2-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
nvidia-cublas-cu12 12.8.4.1 8ac4e771d5a348c551b2a426eda6193c19aa630236b418086020df5ba9667142 https://files.pythonhosted.org/packages/dc/61/e24b560ab2e2eaeb3c839129175fb330dfcfc29e5203196e5541a4c44682/nvidia_cublas_cu12-12.8.4.1-py3-none-manylinux_2_27_x86_64.whl
nvidia-cuda-nvrtc-cu12 12.9.86 210cf05005a447e29214e9ce50851e83fc5f4358df8b453155d5e1918094dcb4 https://files.pythonhosted.org/packages/b8/85/e4af82cc9202023862090bfca4ea827d533329e925c758f0cde964cb54b7/nvidia_cuda_nvrtc_cu12-12.9.86-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl
nvidia-cuda-runtime-cu12 12.8.90 adade8dcbd0edf427b7204d480d6066d33902cab2a4707dcfc48a2d0fd44ab90 https://files.pythonhosted.org/packages/0d/9b/a997b638fcd068ad6e4d53b8551a7d30fe8b404d6f1804abf1df69838932/nvidia_cuda_runtime_cu12-12.8.90-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl
nvidia-cudnn-cu12 9.10.2.21 949452be657fa16687d0930933f032835951ef0892b37d2d53824d1a84dc97a8 https://files.pythonhosted.org/packages/ba/51/e123d997aa098c61d029f76663dedbfb9bc8dcf8c60cbd6adbe42f76d049/nvidia_cudnn_cu12-9.10.2.21-py3-none-manylinux_2_27_x86_64.whl
nvidia-cufft-cu12 11.3.3.83 4d2dd21ec0b88cf61b62e6b43564355e5222e4a3fb394cac0db101f2dd0d4f74 https://files.pythonhosted.org/packages/1f/13/ee4e00f30e676b66ae65b4f08cb5bcbb8392c03f54f2d5413ea99a5d1c80/nvidia_cufft_cu12-11.3.3.83-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl
nvidia-curand-cu12 10.3.9.90 b32331d4f4df5d6eefa0554c565b626c7216f87a06a4f56fab27c3b68a830ec9 https://files.pythonhosted.org/packages/fb/aa/6584b56dc84ebe9cf93226a5cde4d99080c8e90ab40f0c27bda7a0f29aa1/nvidia_curand_cu12-10.3.9.90-py3-none-manylinux_2_27_x86_64.whl
nvidia-nvjitlink-cu12 12.9.86 e3f1171dbdc83c5932a45f0f4c99180a70de9bd2718c1ab77d14104f6d7147f9 https://files.pythonhosted.org/packages/46/0c/c75bbfb967457a0b7670b8ad267bfc4fffdf341c074e0a80db06c24ccfd4/nvidia_nvjitlink_cu12-12.9.86-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl
PINS
library_path="$runtime_dir/onnxruntime/capi"
for library in cublas cuda_runtime cudnn cufft curand cuda_nvrtc nvjitlink; do
  library_path+=":$runtime_dir/nvidia/$library/lib"
done
printf 'export ORT_DYLIB_PATH=%q\n' "$runtime_dir/onnxruntime/capi/libonnxruntime.so.1.23.2"
printf 'export LD_LIBRARY_PATH=%q${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\n' "$library_path"
