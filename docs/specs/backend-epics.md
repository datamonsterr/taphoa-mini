# Backend implementation epics

Status: Accepted · Date: 2026-10-23 · Sources: [OpenAPI](../api/openapi.yaml),
[AsyncAPI](../api/asyncapi.yaml), [data model](../data-model.md),
[architecture](../architecture.md), [object storage spec](object-storage.md),
[monorepo spec](monorepo-setup.md)

## Goal

Implement the full backend contract in `docs/api/openapi.yaml` and `asyncapi.yaml` on the
existing Rust skeleton, connect it to the Railway infrastructure (Postgres + pgvector,
Redis, `images` bucket), seed mock data, host SAM within the latency budget, and run a fast
CI/CD pipeline with real-infrastructure end-to-end tests in a Railway `test` environment.

## Definition of done (whole goal)

1. Test-driven: unit test matrix per module, integration tests against real Postgres,
   Redis and S3 (CI containers using the Railway images, plus the Railway `test`
   environment), Docker build and deployment tests, end-to-end tests against the deployed
   `test` environment.
2. Database seeded with mock data that follows `docs/data-model.md` (`taphoa-seed`).
3. Backend deployed on Railway and callable; responses match the OpenAPI contract;
   hot endpoints p95 < 200 ms on Railway (excluding recognition).
4. SAM segmentation on Railway answers `POST /v1/segment` and `POST /v1/recognition/scans`
   in < 3 s end to end for a 1600 px photo (measured by e2e test, p95 of 5 runs).
5. CI/CD: small parallel jobs, each < 3 min warm, with caching, artifacts and job summaries.

## Shared rules for all epics (conflict control)

- **Module layout** follows [architecture §5.1](../architecture.md#51-module-layout-proposed).
  E1 creates every module folder with an empty `router()` merged in `lib.rs`. Later
  epics edit only their own module folders, their tests, and their migrations.
- **Migrations**: E1 adds the complete schema from data-model §3 (all tables, indexes,
  constraints). Follow-up migrations use reserved version ranges: E2 `01xx`, E3 `02xx`,
  E4 `03xx`, E6 `04xx`, E5 `05xx`. Never edit a migration from another epic.
- **Cross-cutting helpers** live in E1: `error.rs` (`ApiError {status, code, message}`),
  `auth::Actor` extractor, `auth::can(actor, Action)`, idempotency (`request_hash`,
  200 replay / 409 conflict), `events::emit(tx, ...)` that writes `change_log` and
  `outbox_events` in the caller's transaction, `business_date` derivation in
  `Asia/Ho_Chi_Minh`, pagination/cursor helpers.
- **Ports** (`Segmenter`, `Embedder`, `VectorIndex`, `ObjectStore`, `EventBus`) each have an
  in-memory fake. E1 declares `Embedder` and `VectorIndex` traits with fakes; E2 provides
  the real adapters.
- **Tests**: unit tests next to code; integration tests in `crates/api/tests/<module>.rs`,
  marked `#[ignore]` and run with real services; contract tests validate responses against
  `docs/api/openapi.yaml`; e2e specs live in `packages/e2e/tests/<module>.test.ts` and use
  `@taphoa/api-client` against `BACKEND_URL`. Use `cargo nextest` profiles.
- **Performance**: SQLx compile-checked or prepared queries, one round trip per handler where
  possible, indexes starting with `store_id`, connection pool sized from env, Redis for rate
  limits and hot caches, gzip/br compression layer.
- **Secrets** never in git, logs or PRs. New backend variables go into `.railway/railway.ts`
  (`JWT_SECRET: preserve()`) and `.env.example`.
- Conventional Commits. Each epic is one PR.

## Epics

| Epic | Branch                | Scope                                                                                                                                                                                                                                                             | Depends on                         |
| ---- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| E1   | `epic/e1-foundation`  | Full schema migration, error model, config, auth (stores, join, recover, refresh, switch, logout, me, PIN), store settings, members, invites, permission matrix, idempotency, event emit helper, module skeleton, `taphoa-seed` mock data, `packages/e2e` harness | —                                  |
| E2   | `epic/e2-recognition` | SAM hosting under 3 s (model choice, ONNX tuning, warm-up, threads), `Embedder` (DINOv2 ONNX) + `PgVectorIndex`, `/v1/segment`, `/v1/recognition/scans*`, scan timings, model fetch in Dockerfile                                                                 | E1 for HTTP + DB parts             |
| E3   | `epic/e3-catalog`     | Products, units, product images, embeddings on enroll, duplicate check, price history, categories, `/v1/exports/price-list`, image routes aligned with contract                                                                                                   | E1; uses E2 traits via fakes       |
| E4   | `epic/e4-sales-money` | Sales create/void, manual-line review queue, expenses + purchase lines, margin alerts, reports (today, summary, top products, recognition), transactions export, day closes                                                                                       | E1                                 |
| E5   | `epic/e5-cicd`        | CI split into small cached parallel jobs (< 3 min), nextest partitions, artifacts, summaries; Railway `test` environment; deploy to `test` then e2e then production; Railway-services integration job; IaC updates                                                | none to start; final e2e needs all |
| E6   | `epic/e6-sync-events` | `/v1/sync/changes` change feed, `/v1/events` SSE, outbox relay to Redis pub/sub, AsyncAPI event payloads                                                                                                                                                          | E1                                 |

Order: wave 1 runs E1, E5 and the model/latency half of E2 in parallel. Wave 2 starts E3,
E4, E6 and the HTTP half of E2 from the E1 branch once E1 is green. E5 finishes last by
running the full e2e suite against the `test` environment deployed from the combined
branches.

## Task breakdown inside an epic

Each epic conductor writes its own task list with dependencies and DoD, writes failing tests
first, delegates implementation tasks through superorchestrator, reviews diffs, and opens one
PR whose CI must be green.
