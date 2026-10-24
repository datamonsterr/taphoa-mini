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

**Local only, 2026-10-24; Railway D2 pending.** Five sequential uploads of
`shelf-1024.jpg` (1024×768, resized with LANCZOS, JPEG quality 85), each with a new
`image_id` for a cold encoder cache; foreground prompt `(98.6, 179.2)`, then a cached
second call adding background point `(6.4, 6.4)`. Release API, real MobileSAM,
ONNX Runtime 1.23.2, `SAM_THREADS=4`, shared Ryzen 5 2600 host (6 cores / 12 logical CPUs,
no CPU quota). Times are ms; client wall time includes upload and segmentation response,
plus any busy-slot retries. Local traffic uses loopback; Railway runs include WAN upload.
Nearest-rank p95 of five samples is the maximum; cached encoder time is zero.

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

Local reproduction from the repository root: configure exported database, Redis, JWT and
storage variables using `apps/backend/.env.example` and the ports in `docker-compose.yml`.
Export the `ORT_DYLIB_PATH` printed by the runtime script. Run the API in one terminal and
the test in another after `/readyz` returns 200.

```sh
apps/backend/scripts/fetch-onnxruntime.sh && apps/backend/scripts/fetch-models.sh
docker compose up -d postgres redis storage
(cd apps/backend && SAM_ENCODER_PATH=models/mobile_sam_image_encoder.onnx \
  SAM_DECODER_PATH=models/sam_mask_decoder_multi.onnx DINO_MODEL_PATH=models/dinov2_small.onnx \
  SAM_THREADS=4 cargo run --release -p taphoa-api --bin taphoa-api)
# Another terminal, from the repository root:
BACKEND_URL=http://localhost:8080 pnpm --filter @taphoa/e2e exec vitest run \
  --config vitest.e2e.config.ts tests/segment-points.test.ts --silent=false --reporter=verbose
```

Railway reproduction against an existing `test` API with real models and storage:
require **3 passed, no skips** for D2. No deployment performed.

```sh
BACKEND_URL=https://<railway-test-api-domain> SEGMENT_POINTS_BUDGET_MS=3000 \
  pnpm --filter @taphoa/e2e exec vitest run --config vitest.e2e.config.ts \
  tests/segment-points.test.ts --silent=false --reporter=verbose
```
