# ADR 0010: Hybrid object capture: ML Kit on the phone, DINOv2 kNN on the server

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
- **Server:** keeps DINOv2 ViT-S/14 (Apache-2.0) with 224 px letterbox crops, one vector per
  keyframe, index-time augmentation and kNN voting.
- **Detection boxes:** the server uses the phone's boxes when it gets them. MobileSAM remains
  the fallback when no boxes arrive.
- **Training:** none per store.

## Consequences

- New native dependencies: VisionCamera v5, Nitro modules, and a local Kotlin module. The camera
  screen needs a development build. Expo Go no longer works there.
- Five objects per frame on the phone covers a counter scan. Dense shelf scans still go through
  the server fallback.
- A custom detector (RF-DETR or D-FINE through fast-tflite) can replace ML Kit later without
  touching the server contract, because the contract carries boxes, not model outputs.
- Embedding storage grows about 6x per reference (augmentation). pgvector handles about 450k
  vectors per large store.
