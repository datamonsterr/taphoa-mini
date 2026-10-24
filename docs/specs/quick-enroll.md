# Quick enroll: multi-angle references with point-prompted SAM

Status: Proposed · Date: 2026-10-24 · Scope: camera screen, catalog, recognition (E2/E3 follow-up)

## Goal

Enroll a product fast from the camera screen: toggle the tag button, take at least three
photos from different angles, tap one or two points on the product in each photo so
MobileSAM cuts it out, then press Add and type name and price. A background job embeds the
cutouts into the reference database. Checkout recognition then classifies crops few-shot by
cosine similarity against these references.

## Definition of done

| #   | Criterion                                                                                                   | Proof                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| D1  | Tag button is a toggle. On: purple (`colors.accent`), camera is in quick-enroll mode. Off: normal checkout. | Jest `CameraScreen.test.tsx`, Maestro `quick-enroll.yaml`                                |
| D2  | Each photo is segmented from 1 or 2 tapped points in under 3 s, p95 of 5 runs, on the Railway `test` env.   | `packages/e2e/tests/segment-points.test.ts` (WAN upload included); model test in crate   |
| D3  | Reference indexing runs as a background job; product create returns before embeddings exist.                | `tests/index_jobs.rs`: create returns `index_status=pending`; worker moves it to `ready` |
| D4  | Minimum 3 reference images, maximum 8.                                                                      | API 422 below 3 in `references`; 409 above 8; migration test for position `0..7`         |
| D5  | After 3 accepted photos the shutter becomes an Add button that opens the metadata sheet.                    | Jest `QuickEnroll.test.tsx`                                                              |

## Decisions

- **MobileSAM, point-prompted.** Reuse `SamSegmenter` (TinyViT encoder + SAM decoder ONNX).
  New point mode runs the encoder once per photo (~0.8 s on 4 vCPU) and one decoder call per
  prompt set (~150 ms). The encoder output is cached per `image_id` (LRU, 16 entries, 5 min
  TTL) so re-tapping costs only the decoder. SAM 3 is rejected: ~850M parameters, no CPU path
  under 3 s.
- **Client downsizes to 1024 px longest side before upload.** SAM's input side is 1024, so
  larger photos only add upload time.
- **Async index job: embed + prototype, no training.** Job embeds each reference twice with
  DINOv2: the masked cutout and the plain bbox crop. The bbox crop matches what checkout
  crops look like (background included); the cutout gives a clean view. Then it recomputes
  the per-product mean vector (prototype). No model fine-tuning in this scope.
- **Duplicate check stays synchronous but cheap.** Product create embeds only the first
  cutout (one 112 px embed, tens of ms) for the existing duplicate check (`force_new`
  semantics unchanged). All other embeddings come from the job.
- **Few-shot score.** Candidate similarity = `max(best reference cosine, prototype cosine)`.
  Existing `classify` thresholds (match / ambiguous / unknown) apply unchanged.
- **Image cap 3..8.** `product_images.position` widens to `0..7`; `MAX_IMAGES = 8`,
  `MIN_REFERENCES = 3`. The minimum applies to the `references` payload (quick enroll). The
  legacy single-photo `image_ids` path (enroll from an unknown checkout pill) keeps working
  and also indexes through the job.
- **YOLO out of scope.** `YoloSegmenter` stays a stub. See "Checkout without YOLO".
- **Extra angles.** After the third photo the shutter is Add. Photos 4..8 are taken from a
  camera tile in the metadata sheet's photo row (the existing `EnrollScreen` pattern).

## Checkout without YOLO (how price identification works)

Checkout already runs SAM-only (`POST /v1/recognition/scans`, measured p95 2.1 s on Railway):

1. Phone shoots the counter photo; server stores it.
2. **Proposals:** MobileSAM in automatic mode prompts a coarse 4x4 point grid, then only the
   8x8 points no accepted mask covers. Filter by score/area, NMS, dedupe. Output: class-agnostic
   boxes. (`mode=single` keeps the largest central segment.)
3. **Embed:** each box crop goes through DINOv2 (112 px), L2-normalized.
4. **Few-shot search:** pgvector cosine search against `product_embeddings` per store; this
   feature adds the multi-angle references and prototypes that make this step accurate.
5. **Classify:** threshold + margin give `matched` / `ambiguous` (top-k strip) / `unknown`
   (amber `?` pill, enroll path).
6. **Price:** matched product carries its price; detections are added to the cart, the cart
   sums the bill, pay screen shows the VietQR with the exact total.

YOLO would only replace step 2 (box proposals: ~100 ms instead of ~1.2 s, fewer part-of-object
boxes such as caps or labels). It never identifies the product or its price; steps 3 to 6 do
that from the reference database. Known SAM-only limits: over-segmentation of one item into
parts, merging of touching items, and ~1.2 s proposal cost. NMS, dedupe and the classify floor
absorb most of it; the review flow covers the rest.

## API contract (source of truth: `docs/api/openapi.yaml`, `docs/api/asyncapi.yaml`)

`POST /v1/segment/points` (Lead or `can_enroll`)

```json
// request
{ "image_id": "uuid", "points": [{ "x": 812.0, "y": 640.5, "label": 1 }] }
// 200
{
  "bbox": [x, y, w, h], "score": 0.97, "area": 183220,
  "mask": { "width": 256, "height": 192, "png_base64": "..." },
  "cutout_image_id": "uuid",
  "timings": { "encode": 812, "decode": 151, "total": 1040 }
}
```

- `points`: 1..2 items, pixel coordinates of the original photo, `label` 1 = foreground,
  0 = background. 422 otherwise. 404 unknown image. 503 when models are absent.
- `cutout_image_id`: new image (purpose `crop`) holding the masked crop on a neutral grey
  background.

`POST /v1/products` gains `references: [{ image_id, cutout_image_id, bbox }]` (3..8). Response
adds `index_status: "pending" | "ready" | "failed"`. `POST /v1/products/{id}/images` accepts
an optional `cutout_image_id` + `bbox` and enqueues a job.

Event `product.indexed { product_id, index_status, reference_count }` via the outbox, so the
phone clears the "indexing" chip.

## Data model (migration `0501_quick_enroll.sql`)

- `product_images`: position check `0..7`; add `cutout_image_id UUID REFERENCES images`,
  `bbox REAL[]`.
- `products.index_status TEXT NOT NULL DEFAULT 'ready' CHECK (... IN ('pending','ready','failed'))`.
- `product_embeddings.kind TEXT NOT NULL DEFAULT 'crop' CHECK (kind IN ('crop','cutout'))`;
  unique key extended with `kind`.
- `product_prototypes (store_id, product_id, model, embedding vector(384), reference_count,
updated_at, PRIMARY KEY (product_id, model))`.
- `index_jobs (id, store_id, product_id, status queued|running|done|failed, attempts,
last_error, run_after, created_at, updated_at)`; partial index on `status='queued'`.

## Mobile flow

```
tag toggle on (purple)
  -> shutter: capture, downsize 1024, upload        (photo k of >=3)
  -> point overlay: tap 1..2 points -> /v1/segment/points -> mask overlay
       retake | undo point | next
  -> k < 3: back to camera, angle hint "Xoay sản phẩm" + progress dots
  -> k >= 3: shutter morphs into Add (+)
Add -> metadata sheet: photo row (tile adds angles 4..8), name, price keypad, save
  -> POST /v1/products (references) -> toast, "đang học" chip until product.indexed
tag toggle off at any time: confirm discard if k > 0
```

The tag button no longer navigates to `/enroll` after a scan. The amber unknown pill keeps
opening `/enroll` for single-photo enrollment.

## Task graph (TDD: each task lands its failing tests first, then code; SDD: T0 is merged before dependents start)

```
T0 contract ─┬─ B1 crate point mode ── B3 /v1/segment/points ─┬─ E1 latency e2e
             │  B2 cutout (pure)  ─────┘                      │
             ├─ B4 migration ── B5 index worker ── B6 create/enqueue ─┬─ B7 few-shot search
             └─ M0 api-client hooks ─┬─ M1 quick-enroll state machine │
                                     ├─ M2 tag toggle                 │
                                     ├─ M3 point overlay (needs B3 contract only, mocks API)
                                     └─ M4 Add morph + metadata sheet ┴─ E2 Maestro + Playwright flow
```

| ID  | Task                                                                                                                                                                                                        | Depends    | Tests first (acceptance)                                                                                                                   | Route                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| T0  | OpenAPI + AsyncAPI changes above, regenerate `packages/api-client/src/schema.d.ts`, CONTEXT.md terms                                                                                                        | none       | `tests/contract.rs`, `tests/asyncapi.rs`, api-client vitest pass with new schemas                                                          | agy-flash-medium        |
| B1  | `taphoa-recognition`: `PointSegmenter` trait, `SamSegmenter::encode` + `decode_points` (photo coords to 1024 space, mask to bbox at 256 px), `MockPointSegmenter`                                           | T0         | unit: coord transform, label validation, mask-to-bbox; `tests/model.rs`: bottle fixture box IoU >= 0.8 with hand box, < 1.5 s on 4 threads | agy-sonnet-thinking     |
| B2  | `crop::cutout(image, mask, bbox)` masked crop on grey background                                                                                                                                            | T0         | unit: pixels outside mask grey, size equals padded bbox, mask upscale                                                                      | opencode-deepseek-small |
| B3  | `POST /v1/segment/points`: permission, encoder LRU cache by `image_id`, `inference_slots`, store cutout image, timings                                                                                      | B1, B2     | `tests/segment_points.rs` with mocks: 200 shape, 422 for 0 or 3 points, 403 seller, 404, 503, second call hits cache                       | agy-flash-high          |
| B4  | Migration `0501_quick_enroll.sql`, `MAX_IMAGES=8`, `MIN_REFERENCES=3`                                                                                                                                       | T0         | `tests/migrations.rs`: position 7 accepted, 8 rejected; new tables and columns exist                                                       | opencode-deepseek-small |
| B5  | Index job worker: enqueue helper, `FOR UPDATE SKIP LOCKED` poll + LISTEN wake, backoff, max 5 attempts, shutdown via `watch`, embeds crop + cutout, upserts, recomputes prototype, outbox `product.indexed` | B4         | `tests/index_jobs.rs`: job reaches `done`, rerun idempotent, embedder failure retries then `failed`, shutdown stops cleanly                | agy-sonnet-thinking     |
| B6  | Product create / add-image: accept `references`, sync duplicate check on first cutout only, enqueue job, `index_status`                                                                                     | B5         | `tests/catalog.rs`: 422 with 2 references, 409 above 8, create returns `pending`, `force_new` duplicate semantics preserved                | agy-flash-high          |
| B7  | Few-shot scoring: search returns `max(ref, prototype)`; scan pipeline uses it                                                                                                                               | B5         | `tests/recognition_vector.rs`: prototype wins when references are noisy; classify thresholds unchanged                                     | agy-flash-medium        |
| M0  | api-client wrappers + React Query hooks `useSegmentPoints`, `useCreateProduct(references)`, `product.indexed` handling, Jest mock in `src/test/mock`                                                        | T0         | hook tests against the mock                                                                                                                | agy-flash-medium        |
| M1  | `features/camera/quickEnroll.ts` zustand store + reducer: shots, points, status, `canAdd` (k >= 3), max 8                                                                                                   | M0         | reducer tests for every transition, including discard and retake                                                                           | opencode-deepseek-small |
| M2  | `EnrollButton` becomes toggle (`active` prop, accent purple); `CameraScreen` wiring, discard confirm                                                                                                        | M1         | update `CameraScreen.test.tsx` ("tag opens enroll..." cases replaced), `EnrollButton.test.tsx`                                             | agy-flash-medium        |
| M3  | `PointOverlay`: frozen photo, tap 1..2 points, undo, mask overlay from PNG, retake/next, angle progress dots                                                                                                | M1, M0     | component tests: tap maps view to photo coords, third tap replaces second, next disabled until mask                                        | agy-flash-high          |
| M4  | Shutter morphs to Add at k >= 3; extract `ProductForm` from `EnrollScreen`; metadata sheet with photo row (camera tile to 8), save, indexing chip                                                           | M2, M3     | `QuickEnroll.test.tsx`: Add appears at 3, sheet opens, save posts 3 references; `EnrollScreen.test.tsx` still green                        | agy-flash-high          |
| E1  | `packages/e2e/tests/segment-points.test.ts` on Railway `test`, append numbers to `recognition-latency.md`                                                                                                   | B3         | p95 < 3000 ms over 5 runs                                                                                                                  | opencode-muse-long      |
| E2  | Maestro `quick-enroll.yaml` + Playwright `e2e-web/quick-enroll.spec.ts` against the real backend; enrolled product then matched at checkout                                                                 | B6, B7, M4 | both flows pass in CI                                                                                                                      | opencode-muse-long      |

Parallel waves: wave 1 `T0`. Wave 2 `B1 B2 B4 M0`. Wave 3 `B3 B5 M1`. Wave 4 `B6 B7 M2 M3 E1`.
Wave 5 `M4`. Wave 6 `E2`. Each task runs in its own worktree via superorchestrator
(`spawn_agent`, `review: true`); controller reviews `get_run(diff)` before `accept_run`.

## Out of scope

YOLO detector and any model fine-tuning; on-device segmentation; per-store classifier heads;
changing classify thresholds; reworking the single-photo `/enroll` route beyond extracting
`ProductForm`.
