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

## Decisions

- **MobileSAM** (TinyViT encoder, standard SAM mask decoder, ONNX by Acly, pinned revision)
  replaces ViT-B behind the same `Segmenter` trait. ViT-B stays unusable on CPU.
- A decoder call costs ~150 ms of one core (the output-upscaling layers dominate), so the
  default prompt strategy is a coarse round plus only the fine-grid points no accepted mask
  covers yet. Decoders run on one single-threaded session per core (max 4).
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
