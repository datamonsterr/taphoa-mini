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
   - Each kept frame is an upright full-frame JPEG, at most 1024 px on its longest side,
     with the locked box normalized in the same coordinate space as identify. The product
     POST converts that box to saved JPEG pixels, as required by `ProductReference`.
4. A coverage ring shows 8 sectors, filled from how the box shape and position changed.
   Spoken and on-screen prompts say "Xoay sản phẩm", "Đưa ra xa", "Lại gần" and "Lật mặt sau",
   chosen from the empty sectors.
5. Capture stops at 24 kept frames, after 10 s, or when the seller taps stop. At least 8 frames
   are required. With fewer than 8 at 10 s, capture extends to 15 s and prompts
   "Xoay chậm hơn"; fewer than 8 at the cap (or an early stop) offers retry.
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
| M3  | One-trip enrollment: lock, auto keyframes, coverage ring, prompts, voice name and price              | M2, B3     | in review   |
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
  once per stable set, only in the live Object view. One shared gate blocks it for a detected
  receipt, receipt reading, Code mode, armed/capturing enrollment, any enrollment sheet/modal,
  a routed overlay taking focus, and frozen results. Already queued native callbacks consult
  the latest committed gate and synchronous receipt/enrollment pending flags before capture.
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

### M3 implementation notes

- Android retains the purple tag toggle. In Object mode the seller taps a live box once.
  The lock follows its tracking id, then reacquires the best box with IoU at least .3 against
  the last box if the id changes. Missing for over 1 s pauses the ring and displays
  “Giữ sản phẩm trong khung”. Missing time still counts toward the 15 s wall-clock cap.
- Evaluate every 285 ms (about 3.5 fps). VisionCamera Resizer 5.2.4 supplies an upright
  160×160 RGB image with `scaleMode=stretch` (no center crop). Sample a 16×16 luma
  thumbnail inside the normalized locked bbox. Keep only Laplacian variance ≥100 and
  mean absolute thumbnail difference ≥12, or IoU <.6 against the last kept box. The first
  sharp view is kept. These are initial 8-bit luma thresholds: V1 must calibrate on sharp
  and blurred pairs on mid-range Android phones, including low light and small boxes.
- Resizing, CPU frame conversion and JPEG work run on VisionCamera's async runner,
  transferring frame ownership and disposing exactly once. Tracking and encode state use
  separate synchronizable cells with guarded session updates, so completion cannot overwrite
  a new lock. Full frame JPEGs are upright,
  preserve aspect ratio and are at most 1024 px on the longest side. An encode in flight
  prevents another encode; slow devices drop candidates instead of building a frame queue.
- Ring sectors are a variety heuristic relative to the first kept box: 0 baseline;
  1 aspect ratio <.8×; 2 aspect >1.25×; 3 area <.7×; 4 area >1.4×;
  5 center x moved left >.1; 6 right >.1; 7 center y moved >.1 in either direction.
  The union is retained across keyframes. Empty shape sectors prompt “Xoay sản phẩm”,
  then empty distance sectors “Đưa ra xa” / “Lại gần”, then “Lật mặt sau”.
  A short selection haptic announces a changed prompt. This does not prove the back face
  or actual 3D coverage; the prompts ask the seller to supply those views.
- Stop at 24 saved keyframes, 10 s with at least 8, or manual stop. Under 8 at 10 s
  extends to 15 s with “Xoay chậm hơn”; under 8 at the cap/manual stop offers retry.
  Upload each saved frame immediately using `purpose=enrollment`, at most four at once.
  Save waits for all uploads; failures retain the frames and offer “Tải lại ảnh”.
- Capture completion immediately shows “Tên và giá?” and starts the existing voice-sale
  recorder (4 s maximum, 700 ms silence). Its one utterance posts `mode=product`,
  `context={entry:control,screen:camera}`. Name, price and unit prefill the editable sheet;
  the unit maps to `base_unit`. Voice failure, denial, no clip or an 8 s voice deadline
  opens an empty form with name keyboard focus. “Nhập bằng bàn phím” is always available.
  Duplicate and barcode-conflict behavior reuses the existing enrollment sheet.
- The analytics sink emits `one_trip_enrollment_completed` only after product creation:
  `duration_ms` starts at the box tap and includes capture, voice, upload waiting and save;
  `keyframe_count` and `voice_success` contain no product text or audio. Cancel, focus loss,
  mode changes and backgrounding invalidate late answers and clean local frames after uploads.
- Web retains the existing 3..8 photo + point-prompt flow. `PointOverlay` is still used
  there; the Android one-trip path never renders it. No backend or identify changes.
- CI Maestro `quick-enroll.yaml` checks tag arm/cancel with its static emulator camera.
  The full phone smoke is separate and not in `android-e2e.yml`:
  `cd apps/mobile && maestro --device <serial> test .maestro/device/one-trip-enroll.yaml`.
  Start signed in on the Object camera with a ready backend; hold a detected product in
  the center, rotate and change distance while capture runs. This flow exercises typing
  fallback. For C1, speak name and price and save the prefilled form in ten manual trials.
  The median ≤16 s device gate remains V1; automated Jest and APK builds do not measure it.

Verified API sources: [Expo Audio SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/audio/),
[Expo Haptics SDK 58](https://docs.expo.dev/versions/v58.0.0/sdk/haptics/),
[VisionCamera Resizer](https://visioncamera.margelo.com/docs/resizer),
[async frame processing](https://visioncamera.margelo.com/docs/async-frame-processing),
and the pinned 5.2.4 TypeScript/Kotlin frame converter and resizer sources.

### M3 validation (2026-11-02)

- Test-first commits: `732ebbc`, `29672fb`, `5caa88b`, `cc905f9`. The last regression
  reproduced the first capture failing after StrictMode's mount-effect replay before the
  cleanup fix; all six controller regressions now pass.
- `npx tsc --noEmit` passes. `npx expo lint` has no errors and retains the existing
  `VoiceSaleScreen` ref-cleanup warning.
- Full Jest with `--maxWorkers=2 --workerIdleMemoryLimit=512MB --coverage`: **245 suites,
  2,427 tests pass**. Coverage: 95.26% statements, 91.30% branches, 94.51% functions,
  96.29% lines; all configured thresholds pass. Script tests: 13 pass. API client
  typecheck and 47 Vitest tests pass. Changed-file Prettier and `git diff --check` pass.
- Web and Android Expo exports pass. Bundle budget: Android **10,820.4 / 12,089.8 KiB**;
  web gzip **1,251.8 / 1,259.8 KiB**, both pass without a budget increase.
- Docker `:app:assembleDebug` passes, ARM64, `-Xmx6g --max-workers=4`, one Gradle at a
  time: `BUILD SUCCESSFUL in 14m 4s`, 765 tasks. The APK is 132,442,727 bytes;
  SHA-256 `d82f18e2b9365b031d19ba684b2c5c103408e0c09b0fda95e82170d809933f2c`.
  APK inspection includes ML Kit, VisionCamera, Resizer, Worklets and NitroImage libraries.
  CNG output is ignored; incidental package-script rewrites were reverted.
- Both updated Maestro YAML files parse. No device/phone Maestro flow was executed.
  Live async frame capture, sharpness calibration, the voice round trip and the median of
  ten timed Android enrollments remain V1 evidence; this compile/mock validation does not
  establish C1 ≤16 s. M3 is in review for parent integration; no PR, push or cleanup.
