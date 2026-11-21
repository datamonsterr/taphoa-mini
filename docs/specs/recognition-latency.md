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

The look-alike e2e, “matches enrolled products and flags look-alikes as ambiguous,” passed on
Railway `test` in run [40726908085](https://github.com/datamonsterr/taphoa-mini/actions/runs/40726908085).

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
  segmentation 1.6 s + embedding 0.4 s + upload and persistence on 4 cores. Top-1 accuracy at
  112 px has not been measured: the A1 set (50 products, 200 labeled checkout scans) is not
  available in the repository or elsewhere available to this work. The evaluator is ready at
  `apps/backend/crates/recognition/examples/embed_accuracy.rs` and
  `apps/backend/scripts/embed-accuracy.sh` (documented in
  `apps/backend/scripts/recognition-evidence.md`); collecting the photos and running it is an
  open owner item. The architecture target remains >= 90 % top-1.
- **Requires >= 4 vCPU.** With 2 vCPU segmentation alone is 2.9 s. Railway's per-service
  limits are plan dependent; `.railway/railway.ts` sets none.
- **ONNX Runtime thread spinning is off by default** (`ORT_SPINNING`, set `1` or `true` to
  enable). Spinning keeps worker threads busy-waiting while they wait for work; on our
  8 vCPU cgroup shared with the API it burns CPU quota and gets throttled in production.
- Families load on first use after the API starts serving, without synthetic inference.
  `warm` prepares sessions; the first real inference pays arena allocation and validates
  compatibility/output shape. Concurrent first callers share one load (up to 120 seconds
  on warm/background paths);
  load failures/timeouts and occupied inference slots return 503 with `Retry-After: 1`.

## Reproduce

```sh
apps/backend/scripts/fetch-onnxruntime.sh && apps/backend/scripts/fetch-models.sh
cargo run --release -p taphoa-recognition --example bench -- \
  models/mobile_sam_image_encoder.onnx models/sam_mask_decoder_multi.onnx \
  tests/fixtures/shelf-1600.jpg 5
cargo run --release -p taphoa-recognition --example embed_bench -- models/dinov2_small.onnx 20 3 112
cargo test --release -p taphoa-recognition --test model -- --test-threads=1 --nocapture
```

### Additional Railway scan measurements

On 2026-10-28, run [40719821066](https://github.com/datamonsterr/taphoa-mini/actions/runs/40719821066)
measured 12 sequential multi scans of `shelf-1600.jpg` on Railway `test` (sfo), from a GitHub
runner. Scan wall times were 1041, 938, 959, 1023, 1045, 961, 2206, 1010, 1024, 895, 950,
935 ms; nearest-rank p90 was 1045 ms. For the 1600 px segment endpoint, 12 wall-time samples
ranged from 522 to 605 ms, with p90 582 ms. A later `main` run
[40720095867](https://github.com/datamonsterr/taphoa-mini/actions/runs/40720095867)
(commit `fe601d4`) measured scan p90 1830 ms and segment p90 958 ms.

## Point-prompted segmentation (quick enroll)

**Local measured 2026-10-24; Railway `test` measured 2026-10-28.** Five sequential uploads of
`shelf-1024.jpg` (1024×768, resized with LANCZOS, JPEG quality 85), each with a new
`image_id` for a cold encoder cache; foreground prompt `(98.6, 179.2)`, then a cached
second call adding background point `(6.4, 6.4)`. Release API, real MobileSAM,
ONNX Runtime 1.23.2, `SAM_THREADS=4`, shared Ryzen 5 2600 host (6 cores / 12 logical CPUs,
no CPU quota). Times are ms; client wall time includes upload and segmentation response,
plus any busy-slot retries. Local traffic uses loopback; Railway runs include WAN upload.
The Railway gate is nearest-rank p90 of 12 runs, as updated for PR #98 / issue #56;
the local five-run nearest-rank p95 is the maximum. Cached encoder time is zero.

| Run | Upload | Upload + cold segment | Encode | Decode | Server total | Cached 2-point wall | Cached encode | Cached decode | Cached server total |
| --- | ------ | --------------------- | ------ | ------ | ------------ | ------------------- | ------------- | ------------- | ------------------- |
| 1   | 103.0  | 1380.5                | 1047   | 221    | 1273         | 157.3               | 0             | 152           | 154                 |
| 2   | 10.0   | 1190.6                | 1003   | 169    | 1178         | 209.7               | 0             | 204           | 207                 |
| 3   | 103.7  | 1409.5                | 1087   | 212    | 1304         | 176.8               | 0             | 171           | 174                 |
| 4   | 10.1   | 1159.9                | 965    | 175    | 1147         | 242.5               | 0             | 235           | 238                 |
| 5   | 135.2  | 1538.2                | 1163   | 214    | 1401         | 171.0               | 0             | 165           | 168                 |

| Environment    | Encoder threads        | Cold-photo upload + segment                   | Cached 2-point wall         |
| -------------- | ---------------------- | --------------------------------------------- | --------------------------- |
| Local          | 4                      | **1538.2 ms** (p95; < 3000 ms)                | 242.5 ms (p95)              |
| Railway `test` | default (0; all cores) | **1320.6 ms** (p90; max 1457.8 ms, < 3000 ms) | 170.4 ms p90 (180.4 ms max) |

On 2026-10-28, GitHub Actions deploy run
[40726908085](https://github.com/datamonsterr/taphoa-mini/actions/runs/40726908085)
(branch `claude/i91-evidence`, commit `2827c12`, 16:51 UTC) ran
`tests/segment-points.test.ts` against Railway `test` in sfo. Twelve cold uploads of
`shelf-1024.jpg`, each with a new `image_id`, had upload-plus-segment wall times 1457.8,
1320.6, 1238.4, 705.9, 880.7, 728.1, 814.8, 766.8, 810.8, 735.8, 756.4, and 718.2 ms.
Nearest-rank p90 was 1320.6 ms and maximum was 1457.8 ms, below the 3000 ms budget. Server
encode took 320-378 ms, decode 73-88 ms, and total 461-1102 ms. Cached two-point wall time
ranged 146.0-180.4 ms (p90 170.4 ms; maximum 180.4 ms); cached encode was zero.

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

Railway reproduction against an existing `test` API with real models and storage requires
**12 runs for the p90 gate**, with no skips. The linked run above deployed and passed.

```sh
BACKEND_URL=https://<railway-test-api-domain> SEGMENT_POINTS_BUDGET_MS=3000 \
  pnpm --filter @taphoa/e2e exec vitest run --config vitest.e2e.config.ts \
  tests/segment-points.test.ts --silent=false --reporter=verbose
```

## Cost per scan

Controlled workload on 2026-10-28 16:25:17-16:30:55 UTC: 30 sequential multi scans of
`shelf-1600.jpg` (median 20 detections) from a client in Vietnam against Railway `test`, running
`main` commit `fe601d4`. The service was otherwise idle, used one replica, and had
`OCR_THREADS=4`. Railway `CPU_USAGE` GraphQL metrics at 60-second resolution summed to 3.119
vCPU-minutes over the seven buckets from 16:25 through 16:31. After subtracting the idle median
of 0.0011 vCPU, this is 6.2 vCPU-seconds per scan. At $0.000463 per vCPU-minute ($20 per
vCPU-month; Railway pricing checked 2026-10-28), compute cost is $0.000048 per scan, or about
$0.05 per 1,000 scans.

Median storage was 280 KB per scan (164 KB original plus 115 KB crop thumbnails). At Railway
Buckets' $0.015 per GB-month, this is about $0.004 per 1,000 scans per month retained; bucket
egress and S3 operations are free. Backend RAM is a fixed 2.3-3.8 GB baseline, not a per-scan
cost. Database CPU is excluded. These figures are CPU-based; the system runs on CPU, not GPU.

Pricing references: [Railway plans](https://docs.railway.com/reference/pricing/plans) and
[Railway Buckets](https://docs.railway.com/storage-buckets), checked 2026-10-28.

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

## A2: lazy model lifecycle (2026-11-21)

Release API against the existing Docker Compose pgvector Postgres and RustFS on this
shared Ryzen 5 2600 host, pinned with `taskset -c 0-3`, `SAM_THREADS=4`,
`SAM_DECODERS=4`, `OCR_THREADS=4`, ONNX Runtime 1.23.2, checksum-pinned real models.
The baseline was built from the task's starting commit `b3aaa4b4`. No model files, thresholds or
inference algorithms changed. `/healthz` polling interval was 10 ms. RSS is Linux
`/proc/<pid>/status` `VmRSS`; MiB below means KiB / 1024. The initial runs did not
capture host load; later runs record the one-minute load average. These are shared-host
observations, not a controlled latency acceptance run.

### Initial exploratory warm-up measurements (superseded)

The initial exploratory run built the existing `bench` and `embed_bench` examples from
the baseline twice:
unchanged, and with only the load-time warm-up calls removed in a temporary source
copy. Three alternating trials per variant used the same four cores; each measured
one first shelf segmentation or one first DINOv2 crop (112 px). Host one-minute load
was 13.3–15.9. Times are milliseconds; this comparison includes the first real inference.

| Family | First inference with warm-up | First inference without warm-up | Decision                                                                                                                                                             |
| ------ | ---------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAM    | 3523, 3977, 2947             | 3867, 3068, 2787                | Initial removal based on a noisy first-request comparison; superseded by the review follow-up below. Load was 8435–11911 ms with warm-up versus 908–1228 ms without. |
| DINOv2 | 90.3, 57.2, 52.6             | 108.1, 101.5, 110.2             | Initially retained based on first-crop latency alone; the cold-path comparison below supersedes this decision.                                                       |

The exploratory runs compared first inference without counting the load-time inference
itself. The review follow-up below compares both costs and keeps neither synthetic
warm-up. The session creation inside SAM and OCR remains concurrent inside the holder's
blocking loader; builders stay on their own threads, following the pinned
[ort 2.0.0-rc.15 API](https://docs.rs/ort/2.0.0-rc.15/ort/session/builder/struct.SessionBuilder.html).

### Review follow-up: optimize load plus first request

Both families now **create sessions only; no inference runs during loading**. The
controller explicitly chose the combined cold path instead of optimizing only the
first real inference after a synthetic one. All timings below are release binaries,
real pinned models, `taskset -c 0-3`, four SAM threads and four decoder sessions.
Trials alternated warm-up/no-warm-up order between pairs; values are medians in ms.

| Family / variant                   | Cold load | First real inference | Paired cold total |
| ---------------------------------- | --------: | -------------------: | ----------------: |
| SAM, with warm-up                  |    6250.4 |               2313.2 |            8588.4 |
| SAM, without warm-up (**kept**)    |     459.5 |               2382.7 |            2850.6 |
| DINOv2, with warm-up               |     282.9 |                 47.2 |             330.7 |
| DINOv2, without warm-up (**kept**) |     232.3 |                 50.3 |             283.8 |

The paired cold total is the median of each process's load + first inference, so it
can differ slightly from the sum of the two component medians.

SAM: five trials per variant using `bench`, `shelf-1600.jpg` and one first segment;
host one-minute load 9.69–10.87. The four headline numbers are **6250 ms load +
2313 ms first segment with warm-up**, versus **460 ms + 2383 ms without**. Warm-up
saves only 70 ms on the first segment and costs about 5.8 seconds at load. Even though
the first-segment difference is under 5%, the controller superseded that rule and
retained no warm-up: roughly 2.84 s beats 8.56 s on the combined cold path.

DINOv2: ten trials per variant using `embed_bench`, one crop, 112 px input;
host one-minute load 3.75–4.25. Its synthetic inference adds **50.6 ms** to load and
saves **3.1 ms** on the first embed. The controller chose to remove it as well: the
paired cold-total median improves from **330.7 to 283.8 ms**. The DINOv2 loader and
benchmark sources were unchanged from the baseline, so its already-built with/without
warm-up benchmark binaries were reused for these fresh alternating trials.

An **incompatible SAM encoder/decoder pair now fails on the first inference instead
of at load**; the loader cannot detect it without executing the models. Models remain
pinned and checksum-verified by `fetch-models.sh`, and CI runs the real pair in
`crates/recognition/tests/model.rs` (the `sam_end_to_end_small_image` test).
DINOv2 output-shape validation remains in `embed_crops`, and the same CI model suite
checks its 384-dimensional unit vectors. No inference runs outside admission during
loading because neither loader performs inference. Partial OCR sets still fail during
loading with a logged cause and `503` / `Retry-After: 1`; all-absent OCR files leave no
holder. A fake-file unit test covers every partial combination without real models.

Final release API check after removing both warm-ups (one cold process, shared-host
one-minute load **5.44**, four pinned cores): `/healthz` accepted in **40.4 ms**;
`POST /v1/recognition/warm` completed in **907.7 ms**, with overlapping SAM/DINOv2/OCR
loads of **366 / 393 / 905 ms**. A second warm call reported all families already loaded.
The next request was the first real `POST /v1/segment` on `shelf-1600.jpg`: **1614.0 ms**
HTTP wall time, 20 segments. Unlike the older memory-exercise script ordering, no scan
or other model inference preceded this segment. This is a single run, separate from
the paired benchmark medians and the 5% warm-latency acceptance gate below.

Follow-up validation: `cargo fmt --check`, clippy with `--all-targets -- -D warnings`,
and `cargo test` passed (**536 passed, 402 ignored**). The real
`sam_end_to_end_small_image` and `dino_embeds_crops_as_unit_vectors` tests were also run
with the pinned models and both passed. The new partial-OCR unit test covers all file
presence combinations, checks the loader's missing-file cause and its retryable 503.

### Initial session-only SAM trial (DINOv2 still had warm-up)

Shared host, one-minute load **15.02** at startup: accepted `/healthz` in **53.1 ms**.
A cold authenticated `POST /v1/recognition/warm` completed in **1102.0 ms**; a second
call reported `already_loaded=true` for all three families. The per-family durations
include concurrent session creation and the then-enabled DINOv2 warm-up, so they overlap:

| Family | Cold load during concurrent warm |
| ------ | -------------------------------: |
| SAM    |                           635 ms |
| DINOv2 |                           792 ms |
| OCR    |                          1095 ms |

The no-warm-up process used **26032 KiB (25.4 MiB)** RSS at health acceptance and
**644816 KiB (629.7 MiB)** after `warm`. It then exercised real scan, segment and
receipt OCR before the idle unload reading below. Thirty seconds after the last
unload, RSS was **109004 KiB (106.4 MiB; 111.6 MB)**; host load was then **9.40**. These one-sample HTTP latencies
(4953, 3067 and 1982 ms) are recorded only as memory-exercise context, not as the
warm-latency acceptance comparison.

### Allocator experiment and startup

The no-warm-up cycle includes actual scan, segment and receipt inference. The two allocator
comparison cycles below retained SAM synthetic warm-up:

| Variant (shared host)                             | Start → health |  Start RSS | All families loaded RSS |       RSS 30 s after last unload |
| ------------------------------------------------- | -------------: | ---------: | ----------------------: | -------------------------------: |
| Initial lazy, no SAM warm-up; load 15.02 → 9.40   |        53.1 ms |   25.4 MiB |               629.7 MiB | 106.4 MiB (109004 KiB; 111.6 MB) |
| Eager baseline; load not captured                 |      9972.8 ms | 1030.3 MiB |              1032.2 MiB |                    Never unloads |
| Lazy, `malloc_trim` suppressed; load not captured |       238.6 ms |   21.6 MiB |              1160.9 MiB |           279.3 MiB (285976 KiB) |
| Lazy, glibc `malloc_trim(0)`; load 10.25          |        78.2 ms |   21.4 MiB |              1229.8 MiB | 146.9 MiB (150440 KiB; 154.1 MB) |

`MODEL_IDLE_UNLOAD_SECS=15`; all families were loaded by the real authenticated warm
route and a second call reported `already_loaded=true` for every family. The first lazy
trial also accepted health in 52.5 ms. To isolate trimming, the no-trim run used an
`LD_PRELOAD` shim overriding only `malloc_trim` to return zero. Ordinary session drops
left 292.8 MB resident, above the 200 MB acceptance limit; explicit trimming brought
this below the limit. No allocator replacement or child-process inference was needed.
The no-warm-up cycle also remained under 200 MB after all three inference paths. These
measurements did not populate the point encoding/photo cache; that unchanged cache
can retain additional tensors and photos until its next access/insertion evicts them.
Trimming and session destruction run on blocking threads. New acquisitions wait for
unload to finish, then initiate a single reload.

### Warm endpoint latency comparison

The real HTTP measurement script mirrors the existing e2e fixture requests: shelf
1600×1200 scan and segment, plus receipt-1.jpg OCR with local rules fallback (no external
Decisions call). Each endpoint excludes one initial request and then records seven
warm requests. The first comparison retained the existing SAM warm-up; its warm inference
path is the same as the final implementation after the initial request. Host load was
not captured for these early batches; simultaneous builds/inference made it variable.

| Endpoint           |   Before p50 / p95 |    After p50 / p95 | Samples |
| ------------------ | -----------------: | -----------------: | ------- |
| Scan, HTTP wall    | 3584.2 / 4137.8 ms | 3621.8 / 5797.1 ms | 7 each  |
| Segment, HTTP wall | 2444.6 / 2632.3 ms | 2363.2 / 4094.8 ms | 7 each  |
| Receipt, HTTP wall | 1467.7 / 1659.8 ms | 1986.5 / 2837.3 ms | 7 each  |
| Receipt OCR only   |     1452 / 1645 ms |     1966 / 2812 ms | 7 each  |

These noisy batches do not establish the gate. Existing Railway WAN numbers above are not
directly comparable to this local run.

Quiet paired rerun (2026-11-21, one-minute load 1.1 to 2.6, `--compare` with `--latency 20
--idle 15`, baseline and new processes alternated twice on the same four cores,
`SAM_DECODERS=4`):

| Measure                          |               Before |              After |
| -------------------------------- | -------------------: | -----------------: |
| Process start to `/healthz`      |       6008 / 6697 ms |     41.3 / 41.5 ms |
| Resident memory at start         |      1015 / 1026 MiB |    25.9 / 26.4 MiB |
| Resident memory after requests   |      1569 / 1583 MiB |    1597 / 1696 MiB |
| Resident memory 30 s idle        | 1569 / 1583 MiB kept |      135 / 169 MiB |
| Cold `POST /v1/recognition/warm` |                    — |       438 / 452 ms |
| Scan, HTTP wall p50 / p95        |   2430.3 / 2537.7 ms | 2488.4 / 2585.1 ms |
| Segment, HTTP wall p50 / p95     |   1633.7 / 1831.6 ms | 1675.8 / 1773.1 ms |
| Receipt, HTTP wall p50 / p95     |     801.5 / 866.0 ms |   831.6 / 897.0 ms |

The first five rows give both runs of each variant; the latency rows pool 20 warm samples
per endpoint and variant. Warm medians moved by +2.4% (scan), +2.6% (segment) and +3.8%
(receipt), so the **within-5% warm-latency acceptance passes**. Memory after all families
unload is under the 200 MB limit in both runs.

The committed script's
`--compare BASELINE_BINARY` mode alternates baseline/new processes twice, pins each to
the same four cores, and reports p50/p95 over at least 20 warm samples per endpoint and
variant. It also records host load, startup, per-family cold load from `warm`, and RSS
before loading, after loading and 30 seconds after every family unloads. The eager
baseline's per-family times are unavailable (it has no warm route); its cold load is
included in startup and its post-idle memory remains resident.

### Reproduce

Python's `cryptography` package and `taskset` are required. The script uses a cached local
RSA key and JWKS server and creates disposable stores in the chosen local database;
no Clerk account is needed. `--latency` defaults to Compose's local RustFS credentials,
which can be overridden with the storage variables in `.env.example`. It raises the
local receipt quota to allow the measurement batch. Models and the runtime must already
be downloaded; the script does not build, download, deploy or modify model files.

```sh
export CARGO_TARGET_DIR=/media/storage/cache/a2-lazy-models
~/.cache/taphoa-mini/heavy cargo build --release -j 4 \
  --manifest-path apps/backend/Cargo.toml -p taphoa-api --bin taphoa-api
export DATABASE_URL=postgres://taphoa:taphoa@127.0.0.1:55432/a2_lifecycle
export MODEL_DIR=/media/storage/cache/taphoa-models
export ORT_DYLIB_PATH=/path/to/onnxruntime/lib/libonnxruntime.so.1.23.2

# A single memory cycle, including cold warm and idempotent warm calls:
~/.cache/taphoa-mini/heavy python3 apps/backend/scripts/model-lifecycle.py \
  "$CARGO_TARGET_DIR/release/taphoa-api" --idle 15 --output /tmp/a2-memory.json

# Baseline/new alternation, >=20 warm samples per endpoint/variant, memory cycles:
~/.cache/taphoa-mini/heavy python3 apps/backend/scripts/model-lifecycle.py \
  "$CARGO_TARGET_DIR/release/taphoa-api" --compare /path/to/baseline-api \
  --latency 20 --idle 15 --output /tmp/a2-comparison.json
```

Build and save the baseline binary from the starting commit before rebuilding the new
one in the same target directory. Use a reachable, already migrated disposable Compose
database (create `a2_lifecycle` first). Output JSON and adjacent JSONL logs stay outside
the repository by default. The script reports the eager baseline's retained RSS 30 s
later instead of claiming it unloaded.

Validation: default `cargo test` passed 535 tests (402 follow the existing ignored-test
convention); the separate warm membership/idempotence/rate-limit integration tests and
the real-model cached encoding across unload/reload test passed. Fake-loader tests
cover single flight, idle unload/reload, active/cloned inference leases, zero timeout,
cancelled waiters and retry after a failed load. A boot/health/readiness test uses invalid
model files to prove these paths never try to load a session.

## Inference worker

Implementation and measurements on 2026-11-21, Ryzen 5 2600 / GTX 1060 6GB,
ONNX Runtime **1.23.2**, `ort =2.0.0-rc.15`, existing checksum-pinned models and
fixtures. The Rust worker uses the GPU and NVIDIA libraries installed by
`fetch-onnxruntime-gpu.sh`, not the spike's Python environment. CUDA registers on
all six sessions with device 0, HEURISTIC search, a default 3072 MiB arena limit
**per session**, same-as-requested growth and one intra-op thread. The default
SAM decoder pool has one session on CUDA. Dynamically loaded cudart receives
`cudaSetDeviceFlags(4)` before ORT/session creation, enabling blocking sync without
a build-time or default-test CUDA dependency. Registration errors fail loading.
The arena limit is not a global VRAM cap; the desktop retains GPU headroom.

### Output parity

`crates/api/examples/inference_worker_parity.rs` compares the actual synchronous
CPU adapters with remote CUDA traits, including JPEG decoding/preprocessing and
all postprocessing. Both return **20** shelf segments. Across all **64** point
prompts with each provider's own encoder result, minimum binary mask IoU is
**0.9999622656** (required 0.99). Whole-photo DINO cosine is
**0.9999999999990998**, and minimum cosine over all segmented crops is
**0.9999999999896898** (required 0.9999). OCR grouped text matches exactly on all
three receipts: **10 / 11 / 10 lines**. The automatic `Segmenter` trait exposes
boxes/areas rather than masks, so its count is checked separately and binary mask
IoU uses all 64 point decodes through `PointSegmenter`. This is CPU/CUDA numerical parity on the
repository fixtures, not a new labelled accuracy evaluation.

### API latency and resources under limits

In the initial measurement, the same release `taphoa-api` binary serves both
variants against the same local Compose Postgres/RustFS. API affinity is CPUs 0–3,
CPU adapters use four threads /
four SAM decoders, and the CUDA worker runs in a transient
`systemd-run --user --scope -p CPUQuota=200% -p MemoryMax=2G`. Each endpoint discards
one initial request and records **20** sequential warm HTTP requests. Percentiles
use nearest rank (p50 = sorted sample 10, p95 = sample 19). Scan/segment use
`shelf-1600.jpg`; receipt creation uses `receipt-1.jpg` with deterministic parsing,
without cloud Decisions work. Calls include auth, database, local storage and
image/wire processing. There is no tunnel/WAN in these loopback figures.

| Real backend endpoint | Local CPU p50 / p95 ms | CUDA worker p50 / p95 ms |
| --------------------- | ---------------------: | -----------------------: |
| Scan                  |        2275.1 / 2343.1 |            696.0 / 735.6 |
| Segment               |        1568.6 / 1610.6 |            331.5 / 345.6 |
| Receipt               |          829.0 / 935.8 |            333.9 / 354.5 |

Worker warm health takes **2.5 ms**, reporting all families `remote`, zero load
milliseconds and already loaded. API RSS after warm is **28.7 MiB**, versus
**634.7 MiB** after local session creation. After the complete batches the remote
API is **84.3 MiB** and has logged no local model loads; local CPU is **1720.0 MiB**.
Local models unload, leaving **189.8 MiB** API RSS 30 s later. These are process RSS,
not Railway's billed working-set metric.

| Worker resource (all families loaded and exercised) |                         Observation |
| --------------------------------------------------- | ----------------------------------: |
| RSS after API batches                               |                           811.1 MiB |
| Process RSS high-water mark                         |                          1132.9 MiB |
| Process swap at that reading                        |                           362.2 MiB |
| Process VRAM                                        |                            1572 MiB |
| Whole GPU used / free (6 GiB total)                 |                     1829 / 4235 MiB |
| Worker CPU seconds per scan, mean of 20             |                              0.3615 |
| Worker CPU seconds per segment / receipt, means     |                     0.2010 / 0.2925 |
| Idle CPU over 60.044 s                              |   0.030 CPU-s, 0.04996% of one core |
| Idle RSS / VRAM in the separate 60 s sample         |                923.4 MiB / 1558 MiB |
| Scope memory peak (cgroup accounting)               |                           747.8 MiB |
| Scope memory max / CPU quota                        | 2048 MiB / 2 CPU-seconds per second |

The shared host paged some inactive host state: report swap alongside RSS rather
than interpreting resident memory as total host allocation. Cgroup memory accounts
shared file pages differently from process RSS. Every family remains loaded, and
latencies above hold under the limits without OOM or any VRAM exhaustion. GPU
memory is whole-process, not a per-model sum. Desktop/other GPU users retain more
than 4 GiB free. Idle was sampled after parity, before the API batch (the later
batch adds 14 MiB VRAM). Local CPU API process CPU-s per scan averaged **7.761**;
the worker CPU figure excludes the API's remaining preprocessing/network CPU.

The final runs were sequential after compilation and parity completed. Host
one-minute load was **7.19** at CPU startup and **2.25** at worker-backed API startup;
the CPU run finished at **2.65**. These are shared-host observations, not exclusive
hardware or a claim of identical competing load. An exploratory CPU batch that
overlapped compilation/parity is excluded. The prior reference p50 values
2430 / 1634 / 802 ms are consistent in scale but were not substituted for this
run. CPU affinity remains the same as the earlier lifecycle harness; the worker
is quota-limited rather than pinned to those same four cores.

### Memory policy recheck (2026-11-21)

The earlier worker's own `memory.events` high/max/OOM counters stayed zero even
while its pages were swapped under pressure in the shared `user-1000.slice`.
The decided policy therefore keeps the hard cap and prevents worker swap:
`MemoryHigh=infinity`, `MemoryMax=2G`, `MemorySwapMax=0`, `CPUQuota=200%`.
Disabling the worker's soft limit does not remove ancestor slice limits.

After rebuilding the hardened worker and backend, a fresh transient
`systemd-run --user --scope` used exactly those four properties. `systemctl --user
show` confirmed infinity / 2147483648 / 0 and `CPUQuotaPerSecUSec=2s`; the cgroup
files confirmed `memory.high=max`, `memory.max=2147483648` and `memory.swap.max=0`.
Health reported `ready`, provider `cuda`, loaded `sam`, `dinov2` and `ocr`.
The same fixtures/harness, CPU runtime for the API, CPUs 0–3 API affinity and
nearest-rank percentiles were used, discarding one initial call per endpoint.

| Backend endpoint | Earlier worker p50 ms | No-swap worker p50 / p95 ms | p50 change | Warm calls |
| ---------------- | --------------------: | --------------------------: | ---------: | ---------: |
| Scan             |                 696.0 |               674.5 / 697.8 |      -3.1% |         20 |
| Segment          |                 331.5 |               338.3 / 344.4 |      +2.1% |         20 |
| Receipt          |                 333.9 |               332.6 / 348.6 |      -0.4% |         20 |

All p50 changes stay within the existing 5% warm-latency tolerance. This is a
short shared-host regression check, not an exclusive-hardware comparison; startup
one-minute host load was 3.05. Backend warm took 2.3 ms, reported all families
remote/already loaded, and the API log contained no local model loads or fallback.

| Final worker observation                           |                    Value |
| -------------------------------------------------- | -----------------------: |
| RSS and process RSS high-water (each)              | 1145.6 MiB (1173136 KiB) |
| Process swap, before/after and 63 periodic samples |                    0 KiB |
| VRAM after all backend batches                     |                 1522 MiB |
| Scope memory current / peak                        |        767.9 / 771.4 MiB |
| Scope memory.swap.current / memory.swap.max        |                    0 / 0 |
| Scope memory.events high / max / oom / oom_kill    |            0 / 0 / 0 / 0 |

The monitor sampled process/cgroup memory and VRAM every half second while the
API performed the calls. All models stayed loaded, and GPU usage left substantial
headroom on the 6 GiB card that also drives the desktop. The worker and the
harness's API/JWKS processes were stopped; the transient scope became inactive.
No persistent unit or tunnel was started. Raw result/samples, latency JSON and
adjacent logs are retained in
`/media/storage/cache/g-inference-worker/evidence/hardening-noswap/`.

### Fallback drill

A fresh real API process initially warms remotely. The harness sends one shelf
segment, SIGTERMs the worker, sends two more, restarts a fresh scoped worker and
probes after the 30 s breaker window. Every client response is **200**, with
**20 segments**:

| Stage                        | HTTP status | Client wall ms | Backend / evidence                              |
| ---------------------------- | ----------: | -------------: | ----------------------------------------------- |
| Before stop                  |         200 |          346.9 | remote                                          |
| First failed-over request    |         200 |         2088.6 | `worker_transport`, SAM cold load 341 ms        |
| Next call, breaker open      |         200 |         1578.5 | local, `circuit_open`; no second worker request |
| After worker restart / probe |         200 |          376.7 | remote, `inference circuit recovered`           |

Warm after recovery reports all families `remote` and does not load DINOv2/OCR
locally. With `MODEL_IDLE_UNLOAD_SECS=15`, the fallback SAM lease releases and its
sessions unload during the recovery wait; subsequent inference stays remote.
This verifies the idle lifecycle survives fallback. The first failure here is a
refused connection after shutdown, not a blackholed 10 s timeout; that worst case
can spend 10 s remotely before local cold-load/inference, which now shares the
remaining 18 s HTTP request budget. No speculative
parallel inference is used. Both transient worker scopes are stopped afterward;
no persistent service was enabled or started.

### Protocol and lifecycle

The worker exposes eight POST operations under `/v1/`: `segment`, `encode`,
`decode-points`, `embed`, `embed-crops`, `detect-text`, `document-signal` and
`read-lines`. Wire v1 uses bincode 1, fixed-width little-endian fields, a 10 MiB
decode limit and rejected trailing data. Images are bytes, RGB batches avoid PNG
re-encoding, f32 embeddings cost four bytes per element, and masks use one bit per
pixel. Embedding replies include model ID/dimension so different `EMBED_SIDE`
settings cannot silently mix vectors. Both path and content type are versioned;
serde types live in `taphoa_recognition::wire`.

Before transport, crops use exactly the local embedder's Catmull–Rom square resize
to `EMBED_SIDE`; the worker preserves already-sized RGB pixels. Batches contain at
most eight crops, at most 1,204,360 bytes at side 224, safely below the 10 MiB wire
limit. Full-size crops no longer need the oversized-PNG escape path. On the actual
`shelf-1600.jpg` scan (20 crops, side 112), total binary embedding request bodies
fell from **12,720,521 bytes** to **752,984 bytes** across three batches (**94.1%**
smaller). This excludes HTTP headers and the unchanged segmentation photo request.
Tensor parity is tested exactly at every accepted side (56..224, step 14).

Every `/v1/` operation requires a bearer token of at least 32 characters, compared
as constant-time SHA-256 digests. `/healthz` is public and returns exactly status,
provider, loaded families and version. Images are checked before pixel allocation
(4096-pixel edges, existing decode limits), crops/points are validated, one native
operation runs with two queued requests, overload returns 503 / `Retry-After: 1`,
and a 10 s deadline includes body receipt and queue time. Expired/cancelled queued
jobs are skipped; active cancellation is checked between SAM prompts, embedding
batches, OCR batches and recurrent decoder steps. Only a native ORT call already
running is allowed to return before cancellation releases the slot. OCR is limited
to 512 detected boxes / 16 Mi-pixels of total crops, checked before materialisation;
422 `ocr_work_limit` remains a client error without fallback. Before auth, the worker
caps accepted HTTP/1 connections at 32, closes excess immediately, limits headers to
8 KiB / 32 fields, and applies a 3 s header/idle keep-alive deadline. Engine panic
marks health not-ready and exits non-zero for restart. Remote non-loopback HTTP
requires an explicit encrypted-transport override; health bodies are stopped at 4 KiB.
All families, including VietOCR's recognizer even when a blank detector finds no
text, are warmed before the listener binds. SIGTERM drains the service.

A worker encoding is a random handle into a bounded 16-entry / 300 s cache. The
API caches the opaque handle and source bytes, not remote latent tensors.
`410 unknown_encoding` causes one re-encode/retry and updates the cached handle.
Fallback can cache a CPU tensor encoding without retaining its SAM sessions.
The backend uses a 500 ms connect timeout and a 10 s cap per trait call, including
all crop batches and encoding retries, constrained by the remaining HTTP deadline.
Recognition POST routes (scan, segment, segment points, receipts, document probes
and enrollment) share **one 18 s deadline per request**, including payload reads,
model loading, every remote stage, local fallback and storage. The mobile limit is
`SCAN_TIMEOUT_MS = 20_000` in
`apps/mobile/src/features/camera/useScanSession.ts`; two seconds of margin allow the
retryable 503 response to reach the client. Expiry releases HTTP admission and shares
cooperative cancellation with SAM prompts, embedding batches and receipt decoder
steps through `recognition::work::WorkControl`. Native calls already running are
allowed to return, but no further stage starts. Optional detector work retains its
admission while running after a successful scan; cancellation releases it.
A transport failure, timeout or
worker 5xx opens a shared 30 s circuit and uses the existing lazy CPU holder for
that call; subsequent calls go directly local. One half-open probe is admitted
afterward, success closes the circuit, and failure/cancellation reopens it. A late
success cannot close a newer outage. 4xx preserves the worker's status without
fallback. Missing local weights produce retryable 503. No speculative hedging is
used. Warm uses cheap worker health while ready and reports each family's
`backend`; local models still unload after recovery. Logs record `backend` and
fallback `reason` without images/tokens.

Scan document detection is optional throughout loading and inference. Its lazy load
overlaps required SAM/DINOv2 loading and adds no wait once they are ready; failed or
still-loading OCR logs a warning and produces the absent document signal. Detection
itself retains the existing 50 ms maximum tail wait. Receipt OCR loads outside the
transaction, followed by the same hash/replay check under a new transaction.

Index jobs distinguish temporary model availability from real job failures. Load
failure/timeout or remote 503 with no local fallback requeues with exponential
backoff capped at five minutes, without consuming the five-real-failure budget.
Claims stay monotonic for stale-worker fencing; invalid images and storage/inference
errors still count as real failures.

API shutdown stops accepting and releases model-load waiters immediately. HTTP/jobs
and pool cleanup drain for at most 5 s, then PostHog capture and telemetry flush for
at most 5 s each; an explicit Tokio runtime waits at most 1 s for detached blocking
loaders. Total: 16 s plus scheduling overhead; see [deployment](../deploy.md#redaction-retry-and-shutdown).

### Reproduce

All expensive commands use the shared heavy wrapper; build separately, with the
required target directory and four jobs. No tunnel or persistent service startup
is needed for these measurements. Installation and lifecycle commands for the
controller are in [the worker README](../../infra/inference-worker/README.md).

```sh
export CARGO_TARGET_DIR=/media/storage/cache/g-inference-worker
~/.cache/taphoa-mini/heavy cargo build --release -j 4 \
  --manifest-path apps/backend/Cargo.toml -p taphoa-api -p taphoa-infer \
  --bin taphoa-api --bin taphoa-infer --example inference_worker_parity
~/.cache/taphoa-mini/heavy apps/backend/scripts/fetch-onnxruntime-gpu.sh \
  > /tmp/inference-gpu-runtime.sh
```

In a separate terminal, load the runtime exports and a private token, then start
one transient scoped worker (stop it with SIGTERM after measurement):

```sh
source /tmp/inference-gpu-runtime.sh
# Load INFERENCE_TOKEN securely; do not print it or commit it.
export MODEL_DIR=/media/storage/cache/taphoa-models
export INFERENCE_PROVIDER=cuda
export INFERENCE_BIND=127.0.0.1:18090
~/.cache/taphoa-mini/heavy systemd-run --user --scope \
  -p CPUQuota=200% -p MemoryHigh=infinity -p MemoryMax=2G -p MemorySwapMax=0 \
  "$CARGO_TARGET_DIR/release/taphoa-infer"
```

Wait for `/healthz` to say ready. Keep the API/CPU parity process on the separate
CPU runtime (and leave `INFERENCE_PROVIDER` unset there). Use an existing disposable
Compose Postgres database; the harness migrates it, creates disposable stores and
uses a cached RSA signing key/local JWKS, plus local RustFS. It makes no Clerk or
cloud LLM call. Run these sequentially after builds finish:

```sh
export DATABASE_URL=postgres://taphoa:taphoa@127.0.0.1:55432/g_inference_worker
export MODEL_DIR=/media/storage/cache/taphoa-models
export ORT_DYLIB_PATH=/media/storage/cache/taphoa-onnxruntime/lib/libonnxruntime.so.1.23.2
unset INFERENCE_PROVIDER

# First run without worker configuration:
unset INFERENCE_URL
~/.cache/taphoa-mini/heavy python3 apps/backend/scripts/model-lifecycle.py \
  "$CARGO_TARGET_DIR/release/taphoa-api" --latency 20 --idle 15 \
  --output /tmp/inference-cpu.json

# Load the same private INFERENCE_TOKEN used by the worker; never log it.
export INFERENCE_URL=http://127.0.0.1:18090
~/.cache/taphoa-mini/heavy taskset -c 0-3 \
  "$CARGO_TARGET_DIR/release/examples/inference_worker_parity"
~/.cache/taphoa-mini/heavy python3 apps/backend/scripts/model-lifecycle.py \
  "$CARGO_TARGET_DIR/release/taphoa-api" --latency 20 --idle 15 \
  --inference-pid <worker-pid> --output /tmp/inference-remote.json
~/.cache/taphoa-mini/heavy python3 apps/backend/scripts/inference-worker-resources.py \
  <worker-pid> --seconds 60 --output /tmp/inference-idle.json
```

For the fallback drill, run `model-lifecycle.py` with `--worker-pid <worker-pid>`
and `--worker-restart-command /path/to/transient-restart-script`. That script must
load the same GPU runtime/token and start a transient scoped worker on the same
port; it must not enable a service. The harness records a successful remote
segment, stops the worker, records first/local-open-circuit responses, restarts,
waits 32 s, checks recovery and warm, then stops the replacement. It verifies
idle unloading of whichever local families were loaded. JSON and adjacent JSONL
API logs include timings, worker CPU seconds per request, RSS and backend selection.
