# Handoff prompt: quick enroll implementation

Paste everything below the line into a new session.

---

You are the controller for implementing **Quick enroll** in the taphoa-mini monorepo
(Expo mobile app in `apps/mobile`, Rust axum backend in `apps/backend`). Follow the global
CLAUDE.md: subagent-driven development, you plan/brief/dispatch/review/decide, workers edit
source through superorchestrator (load the `use-superorchestrator-mcp` skill before the first
delegation). Do not edit source yourself for delegated tasks.

## Start here

1. Check out branch `claude/product-segmentation-sam-yolo-07b846` (spec commit is its tip).
2. Read `docs/specs/quick-enroll.md` in full. It is the source of truth: goal, DoD table,
   decisions, "Checkout without YOLO", API contract, migration `0501`, mobile flow, task
   graph (T0, B1-B7, M0-M4, E1-E2) with dependencies, tests-first acceptance and worker route
   per task.
3. Read `CONTEXT.md` (new terms: Quick enroll, Point prompt, Cutout, Prototype, Index job)
   and `docs/specs/recognition-latency.md` (MobileSAM timings, thread rules).

## Settled decisions (do not reopen)

- Segmenter: existing **MobileSAM** ONNX (`apps/backend/crates/recognition/src/sam.rs`), new
  point-prompt mode with 1-2 points; encoder output cached per `image_id`. SAM 3 rejected
  (too big for CPU under 3 s).
- Background job: **embed + prototype only**, no model training or fine-tuning. Embeds both
  the cutout and the plain bbox crop per reference; recomputes per-product mean vector; emits
  `product.indexed` via the outbox.
- Image limits: **min 3, max 8** references (`product_images.position` 0..7). Min applies to
  the new `references` payload; legacy single-photo `image_ids` enroll keeps working.
- **YOLO out of scope.** `YoloSegmenter` stays a stub. Checkout keeps SAM grid proposals plus
  few-shot search with score `max(best reference, prototype)`.
- Duplicate check stays synchronous on the first cutout only; `force_new` semantics unchanged.
- Tag button becomes a toggle (purple = `colors.accent` `#5a43e8`); it no longer navigates to
  `/enroll` after a scan. The unknown amber pill still opens `/enroll`.
- After 3 accepted photos the shutter becomes Add, opening a metadata sheet (`ProductForm`
  extracted from `EnrollScreen`); photos 4..8 via a camera tile in the sheet's photo row.
- Phone downsizes photos to 1024 px longest side before upload.

## Definition of done

1. Input mode with 3 images (tag toggle, purple).
2. Point-prompted segmentation under 3 s p95 (5 runs, Railway `test`, WAN included) from 1-2
   points.
3. Indexing runs async as a background job; create returns `index_status=pending`.
4. Min 3 images, can take more (max 8).
5. Shutter turns into Add, which opens the metadata input.

## Code pointers

- Backend recognition crate: `crates/recognition/src/{lib.rs,sam.rs,crop.rs,embed.rs}`,
  model test `crates/recognition/tests/model.rs`, weights via `scripts/fetch-models.sh`.
- API: `crates/api/src/recognition/{handlers.rs,service.rs,classify.rs}`,
  `crates/api/src/catalog/{products.rs,enroll.rs,product_images.rs,model.rs}` (`MAX_IMAGES`),
  `crates/api/src/vector.rs`, background-task patterns in `events/relay.rs` and
  `retention.rs`, `/v1/segment` route in `lib.rs`.
- Migrations: `apps/backend/migrations` (use `05xx` range for this feature).
- Contract: `docs/api/openapi.yaml`, `docs/api/asyncapi.yaml`, generated
  `packages/api-client/src/schema.d.ts`.
- Mobile: `src/features/camera/CameraScreen.tsx` (+ test), `src/components/camera/
{EnrollButton,Shutter,AddButton}.tsx`, `src/features/enroll/EnrollScreen.tsx`, theme
  `src/theme/tokens.ts`, Jest API double `src/test/mock`.
- E2E: `packages/e2e/tests/recognition.test.ts` (latency pattern), `apps/mobile/.maestro`,
  `apps/mobile/e2e-web`.

## How to run it

- SDD: land T0 (contract) first and merge before dependents start.
- TDD: every worker brief requires failing tests first, then code, then the acceptance
  commands green. Put the exact test file names from the spec's task table in each brief.
- Waves: 1 `T0` · 2 `B1 B2 B4 M0` · 3 `B3 B5 M1` · 4 `B6 B7 M2 M3 E1` · 5 `M4` · 6 `E2`.
- Per task: `spawn_agent` with `review: true`, its own worktree, brief = goal / acceptance
  commands / out-of-scope / pointers. Review via `get_run(run, diff: true)`, then
  `accept_run(merge: true)` or `reject_run` with feedback.
- Out of scope: YOLO, fine-tuning, on-device segmentation, per-store classifier heads,
  changing classify thresholds.
- Ask the user before pushing, opening a PR, or changing a settled decision.
