# ADR 0010: Hybrid object capture: ML Kit on the phone, SigLIP2 kNN on the server

Status: Proposed · Date: 2026-11-02 · Spec: `docs/specs/object-capture.md`

## Context

Enrollment needs too many taps. Identify misses rotated, far or partly covered products. All ML
runs on the server CPU: a MobileSAM grid (about 1.2 s), then a DINOv2 ViT-S/14 embedding of
112 px stretched crops. The phone runs no ML, so it cannot show live boxes, lock onto an
object or pick keyframes.

Options for the phone detector:

| Option                                   | Licence                                  | Training needed | Tracking ids | Risk                                             |
| ---------------------------------------- | ---------------------------------------- | --------------- | ------------ | ------------------------------------------------ |
| Ultralytics YOLO trained on SKU-110K     | AGPL-3.0, and the data is non-commercial | no              | no           | ruled out on licence                             |
| RF-DETR-Nano or D-FINE-N via fast-tflite | Apache-2.0                               | yes (one class) | no           | needs a labelled dataset and GPU delegate checks |
| ML Kit Object Detection and Tracking     | Google ML Kit terms, free, on device     | no              | yes          | at most 5 objects; we write a frame plugin       |

## Decision

- **Phone:** VisionCamera v5 with a local ML Kit object detection and tracking frame plugin.
  The plugin drives live boxes, tap-to-lock and auto keyframes.
- **Server (B5 amendment):** defaults to SigLIP2 B/16 224 (Apache-2.0), its learned
  768-d pooled output and mean/std 0.5, with letterbox preprocessing, keyframe/index
  augmentation and kNN voting. `EMBEDDER=dinov2` retains the 384-d DINOv2-S CLS path
  for rollback; both use one ONNX model-spec implementation.
- **Detection boxes:** the server uses the phone's boxes when it gets them. MobileSAM remains
  the fallback when no boxes arrive.
- **Training:** none per store.

## Consequences

- Android's minimum supported version rises from API 24 to API 26 (Android 8.0),
  required by VisionCamera Resizer 5.2.4. `expo-build-properties` sets
  `android.minSdkVersion=26` during CNG; generated native projects remain uncommitted.
- New native dependencies: VisionCamera v5, Nitro modules, and a local Kotlin module. The camera
  screen needs a development build. Expo Go no longer works there.
- Five objects per frame on the phone covers a counter scan. Dense shelf scans still go through
  the server fallback.
- A custom detector (RF-DETR or D-FINE through fast-tflite) can replace ML Kit later without
  touching the server contract, because the contract carries boxes, not model outputs.
- Embedding storage grows about 6x per reference (augmentation). pgvector handles about 450k
  vectors per large store.

## Embedder evidence and migration (B5, 2026-11-02)

The [K=8 comparison](../../apps/backend/eval/results/2026-11-02-embedders.md)
measured SigLIP2 top-1 at 76.2% versus DINOv2-S at 51.5%; packaged goods improved
from 18.7% to 67.3%. The old 0.05 margin alone withheld 71.4% of correct SigLIP2
top-ranked answers. This justifies model-specific calibration, not removing the
margin without precision evidence. Neither model reaches C2's 90% target.

B5 uses a seeded, class-disjoint fit/report split and gallery-vs-gallery duplicate
calibration; the [method, selected defaults and held-half counts](../specs/retrieval-v2.md)
are explicit. Defaults maximize coverage at 95% fit precision and keep >=95% of
known fit queries above the unknown floor. Both 95% and 97% policies miss their
held-class precision targets, so this is a measured coverage/unknown tradeoff,
not a validated precision guarantee. Pinned dynamic INT8 loses 19.0 points of
top-1 (76.2% to 57.1%) and is rejected; production uses the reproduced FP32 export. The dataset is synthetic GroceryStoreDataset transformations, exact
cosine retrieval differs from production HNSW, and the results do not prove shop-photo
accuracy or the 8 s C3 device/WAN latency gate.

Additive migrations keep 384-d data alongside nullable 768-d columns and concurrent
cosine HNSW indexes. Backfill remains bounded by the existing worker rate/admission;
publication replaces only the active model's rows. The image includes both encoders,
so `EMBEDDER=dinov2` restores existing DINOv2 search without deleting SigLIP2 data.
Dropping old dimensions is a later migration after the rollback window. Weights stay
outside git in a versioned, checksum-pinned artifact release; downloads happen while
building the image. No deployment is part of B5.
