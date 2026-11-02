# Object capture: one-trip enrollment and robust identify

Status: Proposed · Date: 2026-11-02 · Supersedes the capture parts of `quick-enroll.md` · ADR 0010

## Problem

- Enrollment takes 3 photos, a point tap per photo, Add, then "new angle". Too many taps.
- Identify misses the same product when it is rotated, far away or partly covered, and shows the
  "new product" pill instead. Causes found in the code:
  - Crops are stretched to a 112 px square (`crop.rs`), so far items are blurry and tilted
    items are distorted differently from their references.
  - Only 3 references per product, no augmentation, and the score is a max against one
    per-product mean vector that blurs distinct views.
  - The MobileSAM grid (8x8 points, `min_score` 0.88) misses small items. In single mode the
    largest segment can be the table.
  - Accuracy was never measured.

## Criteria (owner, 2026-11-02)

| #   | Criterion                                                                                  | Gate                                                         |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| C1  | New product in 16 s or less, including name and price                                      | Median of 10 timed enrollments on a mid-range Android ≤ 16 s |
| C2  | Identify finds products at different distances and angles, several at once, partly covered | Eval top-1 ≥ 90% on enrolled items; per-bucket report        |
| C3  | Identify in 8 s or less; top bar is Object or Code                                         | p95 tap-to-result ≤ 8 s on Railway `test`, WAN included      |
| C4  | Code mode detects a barcode or QR and stores it for later lookup                           | Jest and Maestro flows                                       |

## Decisions

| Topic           | Decision                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inference split | Hybrid. The phone detects and tracks objects live. The server embeds and matches.                                                                        |
| Phone detector  | Google ML Kit Object Detection and Tracking (stream mode, multiple objects, class-agnostic, tracking ids), through a local VisionCamera v5 frame plugin. |
| Camera library  | `react-native-vision-camera` v5 replaces `expo-camera` on the camera screen. Android first.                                                              |
| Embedder        | DINOv2 ViT-S/14 stays (Apache-2.0). 224 px letterbox crops. SigLIP2-B and DINOv3-S are challengers measured on the eval set only.                        |
| Matching        | One vector per kept keyframe plus index-time augmentation. kNN voting (k=20, mean of top-3 per product). Margin is between products.                     |
| Training        | No per-store training. Seller corrections are added as new references.                                                                                   |
| Codes           | Code mode scans EAN-13, EAN-8, UPC-A, UPC-E, Code128 and QR. Digits only, 6–20 characters, stored in `products.barcode`.                                 |
| Modes           | Top bar is Object or Code. Object mode handles one or many items. The Một món / Nhiều món toggle is removed.                                             |
| Eval data       | Public data first (GroceryStoreDataset, MIT). Owner photos later. Non-commercial sets (RPC, Products-10K) only for internal benchmarks.                  |

Rejected:

- Ultralytics YOLO and SKU-110K weights (AGPL-3.0 and a non-commercial dataset).
- A YOLO retrain per product (needs a GPU, takes minutes, and degrades as the catalog grows).
- Novel-view synthesis or "2D to 3D" (no recent evidence it beats real multi-view capture).
- MobileCLIP2 (research licence only).

## Enrollment flow (one trip)

1. Object mode, tag button on. The live ML Kit boxes show what the phone sees.
2. The seller taps the product's box once. The box locks to that tracking id, and the ring
   starts filling.
3. Auto keyframes are taken for 10 s at most:
   - The phone evaluates frames 3–4 times per second.
   - A frame is kept when the locked box is sharp (variance of Laplacian above a calibrated
     floor) and its view changed since the last kept frame (thumbnail hash distance, or box IoU
     below 0.6 against the last keyframe).
   - Each kept frame is cropped to the box with 10% padding and resized to 512 px on its
     longest side.
4. A coverage ring shows 8 sectors, filled from how the box shape and position changed.
   Spoken and on-screen prompts say "Xoay sản phẩm", "Đưa ra xa", "Lại gần" and "Lật mặt sau",
   chosen from the empty sectors.
5. Capture stops at 24 kept frames, after 10 s, or when the seller taps stop. At least 8 frames
   are required.
6. The voice prompt "Tên và giá?" starts. One utterance such as "Mì Hảo Hảo tôm chua cay năm
   nghìn" goes to the existing voice parser, which returns the name and price. The sheet is
   pre-filled, and one tap saves. Typing stays possible.
7. Frames upload in the background while the seller speaks. Create returns
   `index_status=pending`, and the index job embeds and augments the frames.

Upper bound on taps: tag, tap the box, save. About 13–15 s total.

## Identify flow

1. Object mode: ML Kit boxes run live. On shutter (or after the boxes stay stable for 700 ms,
   when auto-identify is on), the phone sends the frame and the boxes.
2. The server uses the phone's boxes when it gets them and skips SAM. It also adds the whole
   frame as a fallback box (from PP-ShiTu). SAM runs only when no boxes arrive.
3. For each crop: a 224 letterbox embed, then kNN voting. Ambiguous crops get test-time
   augmentation (a flip and 2 rotations).
4. The phone keeps a short per-track vote over the last 3 results, so one bad frame does not
   flip the label.

## Code mode

Native Code mode uses the VisionCamera v5 barcode output (EAN-13, EAN-8, UPC-A, UPC-E,
Code128, QR); web retains expo-camera and its fake-webcam e2e path. Digits-only validation,
lookup and unknown-code routing are unchanged.

## Tasks

| Id  | Task                                                                                                 | Depends on | Status      |
| --- | ---------------------------------------------------------------------------------------------------- | ---------- | ----------- |
| M1  | Object or Code toggle, QR in Code mode, Object mode sends `multi`                                    | none       | in review   |
| B1  | Retrieval v2: letterbox 224, index augmentation, kNN voting, re-index backfill                       | none       | in progress |
| B2  | Scan accepts phone boxes (`boxes[]`), skips SAM, adds whole-frame box, TTA on ambiguous crops        | B1         | done        |
| B3  | Enroll accepts 8–24 keyframe references without point prompts; server picks diverse frames           | B1         | done        |
| E1  | Eval harness: GroceryStoreDataset plus synthetic distance, rotation and occlusion buckets; CI report | B1         | pending     |
| N1  | Native spike: VisionCamera v5 + worklets 0.13 on RN 0.88, APK builds in CI                           | M1         | pending     |
| N2  | Local ML Kit object detection frame plugin (Kotlin, Nitro), boxes and tracking ids to a worklet      | N1         | pending     |
| M2  | Camera screen on VisionCamera: live box overlay, Code mode on the barcode output                     | N2         | in review   |
| M3  | One-trip enrollment: lock, auto keyframes, coverage ring, prompts, voice name and price              | M2, B3     | pending     |
| M4  | Identify sends boxes, per-track vote, timing telemetry                                               | M2, B2     | in review   |
| V1  | Gates: C1 timing on a device, C2 eval, C3 latency e2e on Railway `test`                              | all        | pending     |

Every task is test-first: failing tests are committed before the code. Native tasks (N1, N2) are
verified by the CI APK build (`android-apk.yml`) because there is no local Android toolchain.

### M2 / M4 implementation notes

- The native preview stays mounted across mode switches, frozen results and focus changes.
  Object mode attaches one YUV frame output plus a JPEG photo output; Code mode attaches
  the v5 barcode output. The detector and IoU tracker drive at most five live boxes through
  shared values. Frozen results gate detection without changing the outputs during a still
  capture. All native outputs are disposed at unmount; background/blur pauses the camera.
- Photo and frame outputs target the same 4:3 field of view. The SDK 58 bounded image loader
  applies EXIF orientation and saves upright JPEG pixels at at most 1280 px on the longest side.
  Shutter-time raw boxes are rotated, clipped and normalized into that image space. Empty or
  stale boxes are omitted, preserving the server SAM fallback. The receipt probe shares this adapter.
- Auto identify defaults on, persists in settings, and is exposed as “Tự nhận diện” in Account.
  A nonempty track set must stay above .8 IoU for 700 ms, with no new/missing tracks. It fires
  once per stable set, only in the live Object view; frozen results and enrollment block it.
- The last three answers per track vote only for `matched` products. Ambiguous/unknown answers
  cannot replace an established majority. `scan_result_received` records `latency_ms` from
  shutter/auto trigger through the result, with `trigger=tap|auto|retry`, via the analytics sink.
  Timed-out/stale answers do not count as successful C3 measurements. Device/WAN p95 remains V1.

### M2 / M4 validation (2026-11-02)

- Test-first commits: `6f4b527` (initial contracts), `0654156` (integration and lifecycle regressions).
- TypeScript and Expo lint pass; lint retains the existing `VoiceSaleScreen` cleanup warning.
- Full Jest with coverage: 242 suites, 2,397 tests pass. Coverage: 95.37% statements,
  91.38% branches, 94.53% functions, 96.37% lines. The explicit web split suite renders
  expo-camera, exercises Code callbacks and captures through its existing ref API.
- Web and Android Expo exports pass. Bundle budget: Android 10,757.5 KiB / 12,089.8 KiB;
  web gzip 1,247.3 KiB / 1,259.8 KiB. Script tests: 13 pass; updated Maestro smoke YAML parses.
- Expo Doctor: 19/20, with the existing 23 package patch-version mismatches; no new issue.
- Docker `:app:assembleDebug` passes with `-Xmx6g --max-workers=4`, ARM64. The APK includes
  ML Kit object detection and VisionCamera barcode scanner libraries. This is compile and
  packaging evidence; live inference, mode-switch soak, barcode and receipt behavior need a device.
- Playwright web e2e requires `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, a ready real backend,
  and the fake webcam fixture. Credentials are unavailable locally; CI runs it on the PR.
- M2/M4 remain in review for parent integration. C3 p95 and the device gates remain V1.
