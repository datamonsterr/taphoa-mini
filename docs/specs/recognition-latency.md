# Recognition latency (SAM hosting)

Status: Accepted · Date: 2026-10-23 · Scope: [architecture §5.3](../architecture.md), epic E2

Goal: `POST /v1/recognition/scans` and `POST /v1/segment` answer in under 3 s for a 1600 px
photo on Railway CPU (multi mode, point-grid prompts).

## Measurements

Fixture: `apps/backend/tests/fixtures/shelf-1600.jpg` (1600x1200 JPEG, 18 products). Docker
`--cpus N`, ONNX Runtime 1.23.2, intra-op threads = N, 5 runs after load-time warm-up. The
host was shared with other jobs, so treat numbers as +-20 %.

| Setup                                                           | Cores | Segmentation | Notes                                 |
| --------------------------------------------------------------- | ----- | ------------ | ------------------------------------- |
| SAM ViT-B (rajlab export), 64 prompts, full-resolution masks    | 4     | ~20 s        | encoder ~8 s, decoder ~12 s: rejected |
| MobileSAM, 64 prompts, 256 px masks, 4 parallel decoders        | 4     | 3.6 s        | decoder 150 ms per prompt             |
| MobileSAM, coarse 4x4 round then uncovered 8x8 points (default) | 4     | 1.6 s        | encoder 0.8 s, prompts 0.7 s          |
| same                                                            | 2     | 2.9 s        |                                       |

Embedding (DINOv2 ViT-S/14, 20 crops, batch 8):

| Input side | 4 cores | 2 cores |
| ---------- | ------- | ------- |
| 224        | 1.5 s   | n/a     |
| 154        | 1.5 s   | 1.6 s   |
| 112        | 0.40 s  | 0.75 s  |

### Railway `test` environment (sfo, deployed from this branch, client in Vietnam)

`packages/e2e/tests/recognition.test.ts`, 5 sequential runs of the 1600 px fixture, includes
the WAN upload from the client.

| Endpoint                       | Runs (ms)                    | p95     |
| ------------------------------ | ---------------------------- | ------- |
| `POST /v1/recognition/scans`   | 1848, 1992, 1941, 1903, 2101 | 2101 ms |
| `POST /v1/segment`             | 1359, 1406, 1460, 1458, 1372 | 1460 ms |
| scan before background uploads | 2862, 2971, 3178, 2860, 2920 | 3178 ms |

Server-side breakdown of a 20-detection scan on Railway: segment about 1.2 s, embed 0.25-0.4 s,
search 20 ms, persist 80-160 ms. A bucket PUT on Railway takes 0.85-1.7 s (the original photo
upload overlaps with inference; crop thumbnails upload in the background after the response).
One of about 20 runs showed a 3.6 s outlier when the bucket was slow; shared Railway hosts also
vary by +-30 % in segmentation time.

## Decisions

- **MobileSAM** (TinyViT encoder, standard SAM mask decoder, ONNX by Acly, pinned revision)
  replaces ViT-B behind the same `Segmenter` trait. ViT-B stays unusable on CPU.
- A decoder call costs ~150 ms of one core (the output-upscaling layers dominate), so the
  default prompt strategy is a coarse round plus only the fine-grid points no accepted mask
  covers yet. Decoders run single-threaded, one session per worker
  (`SAM_DECODERS`, default `min(threads, 8)` so 8-vCPU hosts use all cores).
- Masks are decoded at 256 px (`SAM_MASK_SIDE`) and boxes are scaled back to the photo.
- **Embedder input is 112 px** (`EMBED_SIDE`, multiple of 14, max 224) to fit the budget:
  segmentation 1.6 s + embedding 0.4 s + upload and persistence on 4 cores. Accuracy at 112
  px is not yet measured against the A1 test set (the architecture asks for >= 90 % top-1);
  raise `EMBED_SIDE` when the plan has spare cores.
- **Requires >= 4 vCPU.** With 2 vCPU segmentation alone is 2.9 s. Railway's per-service
  limits are plan dependent; `.railway/railway.ts` sets none.
- **ONNX Runtime thread spinning is off by default** (`ORT_SPINNING`, set `1` or `true` to
  enable). Spinning keeps worker threads busy-waiting while they wait for work; on our
  8 vCPU cgroup shared with the API it burns CPU quota and gets throttled in production.
- Sessions load and run one warm-up inference at startup; the API returns 503 until ready.

## Reproduce

```sh
apps/backend/scripts/fetch-onnxruntime.sh && apps/backend/scripts/fetch-models.sh
cargo run --release -p taphoa-recognition --example bench -- \
  models/mobile_sam_image_encoder.onnx models/sam_mask_decoder_multi.onnx \
  tests/fixtures/shelf-1600.jpg 5
cargo run --release -p taphoa-recognition --example embed_bench -- models/dinov2_small.onnx 20 3 112
cargo test --release -p taphoa-recognition --test model -- --test-threads=1 --nocapture
```

## Point-prompted segmentation (quick enroll)

**Local measurement only, 2026-10-24; Railway D2 remains pending.**
`packages/e2e/tests/segment-points.test.ts` uploads a new enrollment image before each of
5 sequential one-point calls. Each new `image_id` has a cold encoder cache; the second,
two-point call on that image checks the cache hit (`encode = 0`). Model sessions receive
the normal startup warm-up. The fixture is `shelf-1024.jpg` (1024×768, 81,020 bytes), resized
once from `shelf-1600.jpg` with Pillow 12.2.0 LANCZOS, JPEG quality 85. Foreground prompt:
`(98.6, 179.2)`, scaled from the model test's bottle-body prompt `(154, 280)`; the second
call adds a background point at `(6.4, 6.4)`.

Host: AMD Ryzen 5 2600, 6 physical cores / 12 logical CPUs available, shared local host;
`SAM_THREADS=4` (encoder inference uses 4 threads, no 4-core CPU affinity/quota imposed),
default single-threaded decoder sessions, ONNX Runtime 1.23.2, release API, real MobileSAM
and DINOv2 weights. Client and API use loopback; Postgres, Redis and RustFS are local.
Client wall time includes the full image upload plus segmentation response body and any
busy-slot retry waits. A Railway run of the same test includes WAN upload; these local
numbers provide no WAN or hosted acceptance proof. Node 26.12.0 / pnpm 11.5.0 were installed
locally (pnpm warned that the repository requests Node 24).

All times below are milliseconds; client timings rounded to 0.1 ms. Server encode/decode/
total are the response's `timings` fields. Nearest-rank p95 of 5 samples is the maximum.

| Run | Upload | Upload + cold segment | Encode | Decode | Server total | Cached 2-point wall | Cached encode | Cached decode | Cached server total |
| --- | ------ | --------------------- | ------ | ------ | ------------ | ------------------- | ------------- | ------------- | ------------------- |
| 1   | 103.0  | 1380.5                | 1047   | 221    | 1273         | 157.3               | 0             | 152           | 154                 |
| 2   | 10.0   | 1190.6                | 1003   | 169    | 1178         | 209.7               | 0             | 204           | 207                 |
| 3   | 103.7  | 1409.5                | 1087   | 212    | 1304         | 176.8               | 0             | 171           | 174                 |
| 4   | 10.1   | 1159.9                | 965    | 175    | 1147         | 242.5               | 0             | 235           | 238                 |
| 5   | 135.2  | 1538.2                | 1163   | 214    | 1401         | 171.0               | 0             | 165           | 168                 |

| Environment             | Encoder threads | Cold-photo upload + segment p95 | Cached 2-point p95 |
| ----------------------- | --------------- | ------------------------------- | ------------------ |
| Local                   | 4               | **1538.2 ms** (< 3000 ms)       | 242.5 ms           |
| Railway `test`: pending | pending         | pending                         | pending            |

All 3 e2e cases passed with real models: cold-photo latency/cache-hit shape, 422 for three
points, and 401 without authentication. A model-free backend skips only the latency case
with an explicit message on `503: no model loaded`; a busy `503` retries up to 5 times
using `Retry-After`, with wait time included in the sample. Other failures remain failures.

Local reproduction (run from repository root; Postgres already listening on 55501):

```sh
docker run -d --name qe-e1-redis -p 127.0.0.1:55511:6379 redis:7-alpine
docker run -d --name qe-e1-rustfs -p 127.0.0.1:55512:9000 \
  -e RUSTFS_ACCESS_KEY=taphoa-local -e RUSTFS_SECRET_KEY=taphoa-local-secret \
  -e RUSTFS_CONSOLE_ENABLE=false rustfs/rustfs:1.0.3
# Use only qe_e1, creating it first if absent. Wait for Redis/RustFS readiness.
cd apps/backend
PORT=55513 DATABASE_URL=postgres://taphoa:taphoa@127.0.0.1:55501/qe_e1 \
REDIS_URL=redis://127.0.0.1:55511 \
JWT_SECRET=qe-e1-local-only-secret-0123456789abcdef \
RATE_LIMIT_STORE_CREATE_PER_HOUR=100000 \
AWS_ENDPOINT_URL=http://127.0.0.1:55512 AWS_ACCESS_KEY_ID=taphoa-local \
AWS_SECRET_ACCESS_KEY=taphoa-local-secret AWS_S3_BUCKET_NAME=qe-e1-images \
AWS_DEFAULT_REGION=us-east-1 S3_FORCE_PATH_STYLE=true S3_CREATE_BUCKET=true \
SAM_ENCODER_PATH=/home/dat/dev/taphoa-mini/.qe-models/mobile_sam_image_encoder.onnx \
SAM_DECODER_PATH=/home/dat/dev/taphoa-mini/.qe-models/sam_mask_decoder_multi.onnx \
DINO_MODEL_PATH=/home/dat/dev/taphoa-mini/.qe-models/dinov2_small.onnx \
ORT_DYLIB_PATH=/home/dat/dev/taphoa-mini/.qe-models/onnxruntime/lib/libonnxruntime.so.1.23.2 \
SAM_THREADS=4 cargo run --release -p taphoa-api --bin taphoa-api
# In another terminal, from the repository root, after /readyz returns 200:
BACKEND_URL=http://127.0.0.1:55513 pnpm --filter @taphoa/e2e exec vitest run \
  --config vitest.e2e.config.ts tests/segment-points.test.ts --silent=false --reporter=verbose
# Stop the foreground API with Ctrl-C, then remove the task containers:
docker rm -f -v qe-e1-redis qe-e1-rustfs
```

Railway reproduction, **pending; no deployment performed for this measurement**: use an
already deployed `test` API with real SAM weights, `SAM_THREADS=4`, and object storage
configured. From a client outside Railway, substitute its HTTPS URL below; retain the
3000 ms budget and confirm **3 passed, no skipped tests** before claiming D2.
The visible reporter prints `console.table` even when the Vitest agent reporter would
otherwise hide passing-test logs.

```sh
BACKEND_URL=https://<railway-test-api-domain> SEGMENT_POINTS_BUDGET_MS=3000 \
  pnpm --filter @taphoa/e2e exec vitest run --config vitest.e2e.config.ts \
  tests/segment-points.test.ts --silent=false --reporter=verbose
```
