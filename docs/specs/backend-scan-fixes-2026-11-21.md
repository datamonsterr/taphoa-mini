# Backend scan findings: 2026-11-21

All seven findings were confirmed against starting commit `eedc5a8b`. No model,
threshold, mobile, workflow, worker service or OpenAPI document changed. Work stays
local: no push or PR. Each finding has its own conventional commit.

## Findings, fixes and evidence

1. **Availability consumed the index-job budget — confirmed.**
   `451c0400` adds typed `ModelUnavailable` errors and recognizes remote 503 errors
   without fallback. Migration `1801_index_job_failure_attempts.sql` separates
   permanent `failure_attempts` from monotonic claim `attempts`. Availability keeps
   retrying with exponential backoff capped at 300 seconds; storage, invalid image
   and inference failures still exhaust the five-failure budget. Claim numbers
   remain monotonic so a reclaimed worker cannot publish stale success or failure.
   Tests: `availability_errors_are_distinct_from_permanent_job_failures`,
   `availability_backoff_never_spins_or_overflows`,
   `unavailable_models_retry_past_five_claims_then_recover`, and the existing
   `embedder_failure_retries_then_failed` and
   `reclaimed_lease_fences_old_success_and_failure`. The database regression proves
   eight unavailable claims remain queued with zero permanent failures, then
   recover; the real-failure regression still fails after five errors.

2. **Receipt cold loading held a transaction — confirmed.**
   `74a51b3e` commits the first replay-check transaction before model acquisition,
   then opens a new transaction and repeats the identical advisory lock, operation,
   key and request-hash check. Rate limits remain after the final replay check, so
   concurrent replays do not spend another scan budget. Tests:
   `cold_ocr_wait_holds_no_database_connection` observes every pool connection idle
   while a gated fake OCR loader waits;
   `create_shape_timings_prefilter_and_concurrent_replay` still produces one draft
   and one decisions call for concurrent requests, rejects a changed hash, and now
   also replays successfully after OCR is removed;
   `create_is_rate_limited_per_member_and_replays_are_free` remains green.

3. **Shutdown could wait indefinitely — confirmed.**
   `e76f8e3e` stops HTTP admission, releases holder waiters, and shares one 5-second
   bound across HTTP, background jobs and pool cleanup. Capture then drains for up
   to 5 seconds, telemetry flushes for up to 5 seconds, and the explicitly owned
   Tokio runtime uses `shutdown_timeout(1 second)` for detached blocking work.
   Total application budget: **16 seconds plus scheduling overhead**, documented
   next to the deployment drain note. Tests:
   `drain_is_bounded_and_preserves_completed_results`,
   `shutdown_releases_all_load_waiters_and_rejects_new_leases`, and
   `runtime_shutdown_does_not_wait_for_detached_loader`. Gated native work remains
   outstanding when the latter test's runtime shutdown returns.

4. **Remote stages and fallback could exceed the client timeout — confirmed.**
   `619c4adc` applies one **18-second HTTP budget** to scan, segment, segment points,
   receipt creation, document probes and enrollment. It covers body reads, lazy
   loading, every model stage, local fallback, database and storage waits. The
   mobile limit is `SCAN_TIMEOUT_MS = 20_000` in
   `apps/mobile/src/features/camera/useScanSession.ts`; two seconds remain for
   response/network overhead. The remote 10-second per-call cap is constrained by
   this request deadline. Task and blocking-thread scopes carry the same
   `WorkControl` through local SAM, DINOv2 and receipt OCR hooks. Cancellation releases
   request admission, ends model waits and prevents further cooperative stages;
   expiry uses the existing 503 with `Retry-After: 1`. Tests:
   `slow_local_work_is_cancelled_and_request_permit_is_released`,
   `cooperative_abort_releases_detached_admission_even_when_work_returns`,
   `remote_stages_share_one_deadline_and_expiry_does_not_start_fallback`,
   `failed_remote_cannot_extend_budget_with_a_cold_local_fallback`,
   `cancelled_load_result_is_not_used_for_local_inference`, and
   `recognition_route_timeout_has_existing_retryable_503_shape`.

5. **Optional detector loading could veto checkout — confirmed.**
   `e5247e58` loads optional OCR alongside the required families and adds zero
   waiting time after SAM/DINOv2 become ready. Failure or pending load logs a
   warning and yields the absent document signal. Detector inference retains its
   existing 50-millisecond tail bound, also with a warning on failure/timeout.
   Tests: `failed_or_slow_ocr_does_not_delay_ready_scan_models` and
   `scan_succeeds_when_optional_ocr_family_fails_to_load`. The latter exercises the
   real HTTP/storage/database scan path and returns detections plus the absent
   document signal. Existing document-positive and stalled-detector tests pass.

6. **Full-size crops could exceed the remote wire limit — confirmed.**
   `91a648ce` shares the local embedder's exact Catmull–Rom square resize with the
   transport path. The old common path sent full-size RGB; oversized crops switched
   to PNG, which could still exceed 10 MiB. The new path sends resized RGB batches
   of at most eight crops: at most 1,204,360 bytes at side 224. Tests:
   `remote_crop_tensors_match_local_exactly_at_every_side` compares local and worker
   CHW input tensors exactly for every valid side from 56 through 224;
   `large_crops_reach_worker_as_small_batches` sends nine crops, including random
   image data whose original PNG exceeds 10 MiB, through a fake worker in two
   successful batches; `oversized_crop_and_maximum_batches_fit_the_wire_limit`
   checks binary framing and the maximum batch size.

7. **Plaintext opt-in would be deleted by Railway IaC — confirmed.**
   `afefe57a` preserves `INFERENCE_ALLOW_PLAINTEXT` next to URL/token with the
   requested comment. Auditing today's runtime reads also found
   `INFERENCE_PROVIDER` and `INFERENCE_GPU_MEM_MB` missing from Railway and the
   backend environment example; both are now declared and documented. URL, token
   and idle-unload settings were already covered. `EMBED_SIDE` predates this change;
   `INFERENCE_BIND` and `MODEL_DIR` are worker-only runtime settings, not API config.
   Test: `new_inference_variables_are_preserved_and_documented` checks all six new
   lifecycle/inference settings against both files. No Railway command ran.

## Checks

All Cargo commands used `/media/storage/cache/g-inference-worker`, four build jobs
and the shared heavy wrapper. GPU and remote configuration were unset for the
standard checks. No build cache was cleaned.

- `cargo fmt --check`: passed.
- `cargo clippy --all-targets -- -D warnings`: passed. Cargo still emits the existing
  manifest warning about the unused `axum-extra` dependency; Clippy has no errors.
- `cargo test`: passed, **583 passed / 0 failed / 405 ignored**. Ignored tests require
  external services, real models or explicit opt-in.
- Additional configured-service suites: **12 index-job, 15 receipt, 21 recognition
  and 13 segmentation/segment-points tests passed**, including their ignored integration cases.
- Prettier on touched Markdown/TypeScript: passed.
- `pnpm --filter @taphoa/api-client check:generated`: passed; schema is unchanged.
  OpenAPI did not change, so API regeneration and `lint:api` were unnecessary.
- Commit hooks passed Rust formatting, Prettier where applicable and commitlint.

## Real local CPU sanity and payload measurement

`apps/backend/scripts/model-lifecycle.py` drove the same shelf scan, segment and
receipt requests against the pre-change release binary and the new release binary.
An external wrapper recorded response bodies without changing the harness or repo.
Models came from `/media/storage/cache/taphoa-models`; the CPU runtime was
`/media/storage/cache/taphoa-onnxruntime/lib/libonnxruntime.so.1.23.2`. All warmed
families reported `backend=local`. The GPU service was neither used nor modified,
and its token file was not read.

| Request       | Before wall ms | After wall ms | Result parity                                                               |
| ------------- | -------------: | ------------: | --------------------------------------------------------------------------- |
| Shelf scan    |         3586.6 |        2521.3 | Identical 20 detections, boxes, scores, matches and document signal         |
| Shelf segment |         2703.9 |        1671.7 | Identical 20 segments including boxes, scores and areas                     |
| Receipt       |          884.1 |         808.0 | Identical 4 parsed lines, 456,000 đồng total, 10 OCR lines, fallback parser |

Response comparisons exclude generated IDs, timestamps, signed URLs, timings and
the catalog event counter. These shared-host single-sample timings are sanity
observations, not a performance benchmark.

The actual shelf scan produced 20 padded crops at embedding side 112. Total
embedding request bodies, including bincode framing and excluding HTTP headers:
**12,720,521 bytes before → 752,984 bytes after**, three batches in each case,
**94.081% smaller**. The unchanged segmentation photo request is excluded. The
original fixture's crops fit its split requests; the oversized-image test exercises
the actual failing limit case.

Local evidence lives in
`/media/storage/cache/g-inference-worker/evidence/scan-fixes/`:
`before-responses.json`, `final-responses.json`, `final-parity.json`, `payload.json`,
`test.log`, `integration.log`, `integration-final.log`, `crop-tests.log`,
`clippy.log` and lifecycle logs.

## Remaining limits

A native ONNX call already running cannot be forcibly interrupted. Cancellation
stops the next cooperative stage; expiry releases HTTP admission, so a finishing
native call can briefly overlap the next admitted request. Runtime shutdown bounds
the process's final wait for such work.

A cold path that needs more than 18 seconds now returns retryable 503 while the
shared load continues. Warm/background holder waits retain their 120-second limit.
Migration 1801 preserves historical attempts/statuses; jobs already marked failed
before this fix are not automatically resurrected. No live GPU-worker parity test
was run; transport tests use fake workers and real-model checks use the local CPU.

The task worktree remains on `so/fix-backend-scan-finding-5b3e4481`; no merge or
worktree cleanup was performed because this task explicitly excludes a push/PR.
The final list of remaining checkouts is recorded in the evidence directory's
`worktrees.txt`. No other worktree was modified or removed.
