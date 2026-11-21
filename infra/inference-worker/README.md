# Owner-hosted inference worker

`taphoa-infer` holds the existing MobileSAM, DINOv2, PP-OCR detector and VietOCR
models on the owner's GTX 1060 6GB. The API sends inference over HTTP and retains
its lazy CPU models for outages. The worker has no database, object storage,
Redis, Clerk or telemetry exporter. The tunnel is a separate, later step; this
installation binds only `127.0.0.1:8090`. The release executable is 7.3 MiB;
`ldd` has only the standard C/math/GCC runtime dependencies (ORT/CUDA load dynamically).

On this machine, under a transient 200% CPU / 2 GiB limit, warm API p50/p95 is
696/736 ms for a scan, 332/346 ms for segment and 334/355 ms for a receipt (20
requests each). All families use 1572 MiB VRAM; observed RSS is 811 MiB with 362
MiB swapped, and process RSS high-water is 1133 MiB. A 60 s idle sample uses 0.03
CPU seconds (0.05% of one core). Worker CPU averages 0.3615 seconds per scan.
CPU/CUDA output parity passed on the repo fixtures. These are loopback/shared-host
measurements; the tunnel is unmeasured. Full results and limitations are in
[Inference worker](../../docs/specs/recognition-latency.md#inference-worker).

## Build and install

From the repository root on this machine:

```sh
export CARGO_TARGET_DIR=/media/storage/cache/g-inference-worker
~/.cache/taphoa-mini/heavy cargo build --release -j 4 \
  --manifest-path apps/backend/Cargo.toml -p taphoa-infer
~/.cache/taphoa-mini/heavy apps/backend/scripts/fetch-onnxruntime-gpu.sh
infra/inference-worker/install.sh "$CARGO_TARGET_DIR/release/taphoa-infer"
```

The downloader pins ONNX Runtime GPU 1.23.2 and the eight wheels' exact URLs and
SHA-256 hashes (including seven NVIDIA CUDA 12 libraries measured in the spike).
It requires Linux x86_64, Python 3, curl, sha256sum and flock; it installs no Python
packages and needs no root. It downloads over 1 GB on first use. Verified markers
make repeat installs cheap. It prints shell exports for foreground runs; systemd
needs literal absolute paths in its environment file, without shell expansions.

Create the private environment file, using the already present model directory:

```sh
python3 - <<'PY'
from pathlib import Path
import os
import secrets
root = Path.home() / '.local/share/taphoa-infer/runtime'
config = Path.home() / '.config/taphoa-infer/environment'
values = {
    'INFERENCE_TOKEN': secrets.token_hex(32),
    'MODEL_DIR': '/media/storage/cache/taphoa-models',
    'ORT_DYLIB_PATH': str(root / 'onnxruntime/capi/libonnxruntime.so.1.23.2'),
    'LD_LIBRARY_PATH': ':'.join(map(str, [root / 'onnxruntime/capi'] + [
        root / 'nvidia' / name / 'lib' for name in
        ['cublas', 'cuda_runtime', 'cudnn', 'cufft', 'curand', 'cuda_nvrtc', 'nvjitlink']
    ])),
    'RUST_LOG': 'info',
}
fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as out:
    out.write(''.join(f'{key}={value}\n' for key, value in values.items()))
PY
systemctl --user daemon-reload
systemctl --user start taphoa-infer
curl --fail http://127.0.0.1:8090/healthz
journalctl --user -u taphoa-infer -f
```

The installer copies a prebuilt executable and unit and prints commands. It builds,
starts and enables nothing. `start` above is a deliberate controller action. Optional
login-time startup is `systemctl --user enable taphoa-infer`; no lingering is configured.
The generated token is never printed. Copy it securely to the API's `INFERENCE_TOKEN`
and set `INFERENCE_URL` to the eventual worker address. For a local test, use the
loopback URL. Leave `INFERENCE_PROVIDER` unset on the API so fallback uses CPU.
Do not configure the tunnel as part of this installation.

The worker defaults to CUDA in the unit, 3072 MiB **per-session** arena limit,
HEURISTIC convolution search, same-as-requested arena growth, one intra-op thread
and one SAM decoder. This arena limit is not a global VRAM cap; retain desktop
headroom. Blocking synchronization is set through dynamically loaded cudart before
ORT creates sessions. The implementation follows the pinned
[CUDA provider API](https://docs.rs/ort/2.0.0-rc.15/ort/ep/cuda/struct.CUDA.html) and
[session builder API](https://docs.rs/ort/2.0.0-rc.15/ort/session/builder/struct.SessionBuilder.html),
with `cuda` alongside `load-dynamic` and `error_on_failure()` registration.
A missing provider/runtime fails startup instead of silently
using CPU. For a CPU worker, override `INFERENCE_PROVIDER=cpu` and its runtime path.
The worker and API must use the same `EMBED_SIDE` (default 112); mismatches fail over
locally rather than mix embeddings. Existing model paths can each override `MODEL_DIR`.

## Protocol and limits

All inference routes are POST and require `Authorization: Bearer <INFERENCE_TOKEN>`
and `Content-Type: application/vnd.taphoa.inference.v1`:

| Route                 | Argument                          | Result                               |
| --------------------- | --------------------------------- | ------------------------------------ |
| `/v1/segment`         | JPEG/PNG bytes                    | Segments                             |
| `/v1/encode`          | JPEG/PNG bytes                    | Opaque handle, original width/height |
| `/v1/decode-points`   | Handle, 1–2 labelled pixel points | Segment, low-res bit-packed mask     |
| `/v1/embed`           | JPEG/PNG bytes                    | Model ID, dimension, one f32 vector  |
| `/v1/embed-crops`     | RGB byte crops with dimensions    | Model ID, dimension, f32 vectors     |
| `/v1/detect-text`     | JPEG/PNG bytes                    | Text boxes                           |
| `/v1/document-signal` | JPEG/PNG bytes                    | Document signal                      |
| `/v1/read-lines`      | JPEG/PNG bytes                    | Ordered OCR lines                    |

Wire v1 is bincode 1 with fixed-width little-endian numbers and trailing bytes
rejected. Images are byte sequences, embeddings cost four bytes per f32 and masks
one bit per pixel (row-major, low bit first). The version is in both path and media
type. The shared serde types are in `taphoa_recognition::wire`. JSON is used only for
public `GET /healthz`, which has exactly status, provider, loaded families and version.

Tokens need at least 32 characters and are compared using constant-time SHA-256
digests. Bodies are limited to 10 MiB; images to 4096 pixels per edge and decoded
allocation limits. Crop dimensions/lengths and points are checked before inference.
One operation runs while two wait. Excess work returns `503` with `Retry-After: 1`.
Each request has a 10 s deadline covering body receipt and queue time. Already running
native work retains its slot until it finishes even if its HTTP deadline expires.
SIGTERM drains requests and native work; the unit permits 30 s to stop.

The worker holds at most 16 SAM encodings for 300 s, evicting oldest insertions.
Handles are random UUIDs. `410` with code `unknown_encoding` distinguishes expiration
or restart; the API retains source bytes and re-encodes/retries once, updating the
cached handle. A local encoding from fallback is independently cached and re-encoded
on the worker after recovery. No embeddings or photographs are persisted by the worker.

The backend circuit opens for 30 s after transport failure, timeout or 5xx and sends
subsequent calls directly to lazy local holders. One probe is admitted after that;
success closes the circuit, failure/cancellation reopens it. 4xx does not fall back.
No simultaneous hedged inference is issued. Warm uses the cheap health route when
ready and otherwise loads local models. The API response includes each family's
selected `backend`; local sessions unload after `MODEL_IDLE_UNLOAD_SECS` as usual.

## Service constraints and operation

The template sets `CPUQuota=200%`, `MemoryHigh=1536M`, `MemoryMax=2G`, `Nice=5`,
`Restart=on-failure`, `NoNewPrivileges=yes`, a private temporary directory, read-only
home/system, SUID/realtime/kernel/control-group restrictions, a locked personality,
and only Unix/IPv4/IPv6 socket families. These options were tested with a transient
user service on this machine, including actual GPU model warm-up and a ready health
response. `PrivateDevices` is omitted because it hides `/dev/nvidia*`. The CUDA cache
is writable under the user's systemd state directory. No system package or privileged
capability is required. The resource benchmark used a transient user scope; nothing
was persistently enabled or started during implementation.

Update by rebuilding in a heavy slot and rerunning `install.sh` with the prebuilt
binary, then `systemctl --user daemon-reload` and `systemctl --user restart taphoa-infer`.
The installer replaces the executable atomically. Keep the previous executable if
rollback is wanted. Models and tokens are separate and survive updates.

Stop with `systemctl --user stop taphoa-infer`. To rotate the token, generate a new
32-byte random token into the mode-600 environment file, securely update the API's
`INFERENCE_TOKEN`, then restart the worker and API. The short mismatch window returns
401 and does not open the circuit; coordinate this during a quiet period.

To remove:

```sh
systemctl --user disable --now taphoa-infer
rm ~/.config/systemd/user/taphoa-infer.service ~/.local/bin/taphoa-infer
systemctl --user daemon-reload
# Optional: remove the token, downloaded runtime and CUDA cache after review:
# rm -r ~/.config/taphoa-infer ~/.local/share/taphoa-infer ~/.local/state/taphoa-infer
```

Models in `/media/storage/cache/taphoa-models` are shared and must be kept. Runtime
installation is owned by this worker; removing it does not touch the separate CPU
runtime or the GPU spike's Python environment.

## Acceptance and implementation report

All three implementation parts are committed separately (CUDA provider, worker,
then API fallback plus packaging). The code leaves the existing model files,
recognition thresholds/results and mobile application unchanged.

| Acceptance item                   | Result and evidence                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default CPU-only workspace checks | PASS: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test`, 547 passed / 402 existing ignored tests. No GPU variables were set. Clippy exits 0; Cargo reports the existing unused `axum-extra` manifest warning.                                                                                                                                |
| Formatting / OpenAPI              | PASS: Prettier on every touched Markdown/TS/YAML file; `pnpm lint:api` validates the warm response's `backend` property, with six pre-existing warnings.                                                                                                                                                                                                                     |
| Fake model/worker tests           | PASS: remote success; refused transport / 5xx local fallback; open circuit and single half-open recovery; stale-success protection; 4xx propagation; one unknown-handle renewal; warm remote and local states; auth missing/wrong/right, 10 MiB body limit, saturated admission 503/Retry-After, invalid dimensions/crops, bounded/expired handles and mask/wire round-trip. |
| GPU install / startup             | PASS: all eight wheel SHA-256 checks, idempotent rerun; actual worker ready on CUDA using installed libraries; strict provider registration and blocking sync.                                                                                                                                                                                                               |
| Real CPU/CUDA parity              | PASS: 20 segments; minimum of 64 mask IoUs 0.9999623; crop cosine >=0.99999999998; identical OCR text on three receipts.                                                                                                                                                                                                                                                     |
| Real API latency                  | PASS: 20 warm calls per endpoint per mode, same release API, CPU-only then CUDA worker under the requested scope limits; table in latency spec.                                                                                                                                                                                                                              |
| Outage / recovery / unloading     | PASS: statuses 200 throughout; first local call 2088.6 ms; open-circuit call 1578.5 ms; recovered remote 376.7 ms. Logged cold load, breaker reason, recovery and SAM idle unload; warm returns remote without local loads.                                                                                                                                                  |
| Resources and user sandbox        | PASS: scope enforces 200% CPU / 2 GiB; latency holds, all-model RSS/VRAM, CPU-s per scan and 60 s idle measured. The listed sandbox settings also started real CUDA models in a transient user service and returned ready.                                                                                                                                                   |
| Documentation / packaging / scope | PASS: unit, copy-only installer, operator instructions, architecture and latency report. No tunnel, deploy workflow, Railway command, persistent unit startup, push or PR. All test worker processes/scopes stopped.                                                                                                                                                         |

Raw JSON and logs are retained on this machine in
`/media/storage/cache/g-inference-worker/evidence/`: `g-parity.json`,
`g-cpu-final.json`, `g-remote-final.json`, `g-fallback-drill.json`,
`g-worker-idle.json`, adjacent API logs, final test/clippy/OpenAPI/Prettier logs and
scope/sandbox evidence. The excluded exploratory batch is not used in the report.

Changed files are grouped as follows:

- `apps/backend/Cargo.toml` / `Cargo.lock`, recognition manifest and
  `src/{provider,wire,lib,sam,embed,ocr}.rs`, plus `ocr/viet.rs`: provider policy,
  shared binary types, opaque encoding support and explicit recognizer warm-up.
- `apps/backend/scripts/fetch-onnxruntime-gpu.sh`: pinned rootless native runtime.
- `apps/backend/crates/infer/{Cargo.toml,src/lib.rs,src/main.rs}`: standalone worker,
  admission/security/cache, tests, startup/warm-up and shutdown.
- API `src/{config,lib,main,models,model_holder,remote_models}.rs`,
  recognition warm/points/handlers/service, catalog enrollment and receipt HTTP:
  settings, trait adapters, lazy fallback and HTTP error/backend reporting.
- `crates/api/examples/inference_worker_parity.rs`,
  `scripts/model-lifecycle.py` and `scripts/inference-worker-resources.py`: real
  parity, API/CPU/resource measurement and stop/restart drill.
- Backend `.env.example` / `README.md`, `.railway/railway.ts` (only two preserved
  settings and one comment), OpenAPI, architecture/latency docs and this directory.

Open operational limits: results cover fixtures and loopback, not WAN/tunnel
latency or labelled model accuracy; the host has competing load and swap. A
blackholed worker can cost 10 s before CPU fallback, which may also be cold. Warm
honors the same 30 s circuit, so it warms locally during an open interval. The
GPU arena limit is per session rather than a total VRAM reservation; monitor
headroom with new workloads. Native calls already running at a deadline finish
before their slot is released. Token rotation requires coordinated API/worker
restarts. The service is available when the user manager is running; login-time
startup is optional and lingering was not configured.
