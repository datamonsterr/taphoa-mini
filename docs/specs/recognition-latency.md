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

## Receipt OCR

Measured 2026-10-25 with the real checksum-pinned OCR models, `OCR_THREADS=4`,
`inception/mercury-decide:free` through OpenRouter, and the document detector enabled
in checkout scans. Receipt fixture:
`apps/backend/crates/recognition/tests/fixtures/receipts/receipt-1.jpg` plus its
expected JSON (four products, total 456,000đ). Catalog products use the fixture
names and a retail price of 15,000đ, deliberately different from wholesale costs.
The integration check exposed and fixed a mapping prompt that compared those
prices: matching now uses product identity and explicitly ignores prices.

Five sequential `POST /v1/receipts` requests reuse the checkout scan's image ID
with a fresh idempotency key each time. No receipt warm-up or successful-request
retry is excluded. OCR, decisions and server total come from `Receipt.timings`;
wall time includes the HTTP response body. Nearest-rank p50 is the third sorted
sample and p95 is the maximum of five. Live e2e files run sequentially so other
suites do not compete for the inference slot. All receipt lines and mappings,
confirmation replay, expense/purchase lines, receipt movements, and a sale
crossing a per-product stock threshold are asserted through the real API.

Local release API: shared Ryzen 5 2600 host (6 cores / 12 logical CPUs),
`SAM_THREADS=4`, loopback HTTP and isolated Compose pgvector/Redis/RustFS.

| Local run | OCR ms | Decisions ms | Server total ms | Wall ms |
| --------- | ------ | ------------ | --------------- | ------- |
| 1         | 3837   | 1703         | 5546            | 5564.0  |
| 2         | 1401   | 560          | 1968            | 1980.3  |
| 3         | 1190   | 574          | 1770            | 1784.4  |
| 4         | 1011   | 548          | 1568            | 1580.6  |
| 5         | 986    | 580          | 1571            | 1581.2  |

| Environment    | OCR p50 / p95 ms | Decisions p50 / p95 ms | Server total p50 / p95 ms | Wall p50 / p95 ms   | Scan p95 ms |
| -------------- | ---------------- | ---------------------- | ------------------------- | ------------------- | ----------- |
| Local release  | 1190 / 3837      | 574 / 1703             | 1770 / 5546               | 1784.4 / **5564.0** | **2430**    |
| Railway `test` | 443 / 491        | 335 / 461              | 892 / 1049                | 1225.1 / **1349.4** | **1575**    |

Railway `test` deployment `f46da787-fe59-447f-bee7-57aa00719044` reached
`SUCCESS`; `/readyz` returned 200 with storage configured. The client was in
Vietnam and the running origin was `railway/us-west2` (SFO). All five receipt
requests used the decision model, with no fallback or skip.

| Railway run | OCR ms | Decisions ms | Server total ms | Wall ms |
| ----------- | ------ | ------------ | --------------- | ------- |
| 1           | 416    | 461          | 1010            | 1225.1  |
| 2           | 430    | 424          | 892             | 1102.7  |
| 3           | 491    | 335          | 871             | 1089.3  |
| 4           | 455    | 290          | 783             | 1349.4  |
| 5           | 443    | 286          | 1049            | 1265.1  |

Railway scan samples with document detection were 1301, 1575, 1188, 1249,
1170 ms; segmentation p95 was 874 ms. The complete API suite had **65 passed,
one failed, one existing TODO**, with no OCR skips. Its only failure was the
unchanged hot-endpoint 200 ms client p95 gate (details below). A verbose receipt
and recognition measurement run passed six tests with the same existing TODO.
The web suites against this backend passed **7/7** Chromium tests (36.8 s).
The existing receipt web spec exercises empty history; it does not yet exercise
the camera-to-review-to-confirm flow from E2.

The first Docker build (`9e311a23-f6d7-443d-9a3b-b48047df1e39`) finished dependency
compilation in 19m19s, then failed with `DeadlineExceeded: context deadline
exceeded` before the application build. Raising `CARGO_BUILD_JOBS` from 2 to 4
reduced dependency compilation to 5m42s; application compilation took 1m22s and
the retry deployed successfully. Startup runs `MIGRATOR` automatically. No
Railway services were removed, and only the `test` environment was changed.

The local scan samples with document detection were 2246, 2430, 2339, 2222,
2308 ms; segmentation p95 was 2535 ms. An earlier local run under concurrent
host load failed scan/segmentation budgets at 6278/4467 ms; these measurements
are sensitive to shared CPU load. The final local release checks passed seven
tests with one pre-existing recognition TODO. Both document-positive receipt and
document-negative shelf photos passed. A separate debug real-model DB acceptance
also passed at 4193 ms wall (OCR 3133 ms, decisions 762 ms); it is not included in
the release statistics.

Reproduce after starting the release API with models, storage and decision
configuration (the fixture product photo lives in `apps/backend/tests/fixtures`):

```sh
BACKEND_URL=http://localhost:8080 pnpm --filter @taphoa/e2e exec vitest run \
  --config vitest.e2e.config.ts tests/receipts.test.ts tests/stock.test.ts \
  tests/recognition.test.ts --reporter verbose
BACKEND_URL=https://backend-test-70c2.up.railway.app pnpm --filter @taphoa/e2e test:e2e
```

### Hot-endpoint gate follow-up

The full API run failed only `latency.test.ts`: `/v1/store` 205 ms,
`/v1/members` 205 ms, `/v1/products` 204 ms, `/v1/alerts` 210 ms and
`/v1/sync/changes` 218 ms exceeded the existing 200 ms client p95 budget.
The test was rerun twice sequentially without changing its budget or samples.

Railway HTTP logs expose `upstreamRqDuration` in milliseconds, the time the
application took to respond ([timing field definitions](https://docs.railway.com/deployments/troubleshooting/slow-deployments)).
There was no `Server-Timing` response header. Each rerun's UTC start/end window
was captured, then its HTTP GET records were fetched for the deployed ID and
Node client. Every endpoint had exactly 31 records: the first warm-up was
dropped, leaving the same 30 requests as the client measurement. These are
application/upstream elapsed times, including authentication and database work,
not isolated CPU profiles. Values below are rounded to integer milliseconds;
the gate compares unrounded client measurements.

| Endpoint            | Rerun 1 client p95 | Rerun 1 upstream p95 | Rerun 2 client p95 | Rerun 2 upstream p95 |
| ------------------- | ------------------ | -------------------- | ------------------ | -------------------- |
| `/v1/me`            | 215                | 21                   | 215                | 24                   |
| `/v1/store`         | 215                | 9                    | 206                | 22                   |
| `/v1/members`       | 198                | 9                    | 210                | 20                   |
| `/v1/products`      | 201                | 10                   | 208                | 17                   |
| `/v1/categories`    | 207                | 12                   | 204                | 17                   |
| `/v1/reports/today` | 219                | 16                   | 209                | 23                   |
| `/v1/alerts`        | 207                | 17                   | 207                | 20                   |
| `/v1/sync/changes`  | 223                | 37                   | 205                | 18                   |

Rerun 1: `2026-10-24T19:22:42Z`–`19:23:32Z`; rerun 2:
`19:23:32Z`–`19:24:23Z`. Both failed the unchanged client gate. The slowest
individual upstream request was 44 ms in rerun 1 and 36 ms in rerun 2, well
below 200 ms. A warmed unauthenticated `/healthz` control independently measured
client times 191.7, 190.1, 185.4, 194.1, 181.7 ms while the exact request IDs in
Railway logs measured 1, 2, 3, 4, 1 ms upstream. Debug headers identified origin
`railway/us-west2` and edge `hkg1`.

This is an environmental WAN/edge latency miss from this machine to the test
region; the measurements do not show a handler-budget regression. The stock
change adds a primary-key store-threshold lookup to product projection. The
latency test creates a fresh empty store, so that per-product lookup is not
executed, and sync skips product loading when there are no product changes.
Store reads add the threshold column to their existing query, with no extra
join or database round trip. No speculative handler change or gate relaxation
was made. The complete API suite therefore remains reported as failed, despite
all receipt/stock/recognition acceptance checks passing.
