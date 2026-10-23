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
