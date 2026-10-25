# Epic briefs

Status: Accepted · Date: 2026-10-25 · Program: [README](README.md)

Each epic session is a controller (see "Shared rules" in the README). It reads the README, this
file's section for its epic and the linked specs, writes its own task graph (TDD, waves,
worker route per task) into a new section at the end of its epic's spec file or a new
`docs/specs/assistant/<epic>-plan.md`, then executes it. "Owns" lists the files the epic may
change; "Touches" lists agreed integration points it may edit minimally.

---

## X0 · Assistant contract and shared interfaces

- **Branch:** `epic/x0-assistant-contract` · **Depends:** none · **Wave:** 1 (merge first)
- **Goal:** land the API and event contract for the assistant, next steps, digest and devices,
  plus the thin shared interfaces other epics code against, so wave 2 can run in parallel.
- **Owns:** assistant, next-steps, digest and devices sections of `docs/api/openapi.yaml` and
  `docs/api/asyncapi.yaml`; `packages/api-client/**` (regenerate `schema.d.ts`, add an SSE
  helper for the message stream); assistant handlers in `apps/mobile/src/test/mock`;
  `apps/mobile/src/lib/analytics.ts` (typed `capture(event, props)` over the product-event union
  from the telemetry contract, no-op implementation); `apps/backend/crates/api/src/analytics.rs`
  (`ProductEvent` enum and `Analytics` trait with a no-op implementation, in `AppState`).
- **Touches:** `lib.rs` migrator: tolerate missing versions so branch deploys to the shared `test`
  database do not break `main` deploys (check the current SQLx API).
- **Tasks:** contract per [assistant.md](assistant.md) "API contract" and SSE events; schemas
  for `AssistantThread`, `AssistantMessage`, `AssistantAction`, `NextStep`, `Digest`, `Device`;
  AsyncAPI `assistant.action.confirmed` / `rejected`; mock handlers that stream canned SSE.
- **Acceptance (tests first):** `tests/contract.rs` and `tests/asyncapi.rs` pass with the new
  paths; api-client vitest covers the SSE parser (deltas, tool events, error, reconnect stop);
  mobile Jest mock test for one streamed reply; `pnpm turbo run typecheck test` green.
- **Out of scope:** auth and debt contract (X1, X5), any handler code.

---

## X1 · Clerk identity

- **Branch:** `epic/x1-auth-clerk` · **Depends:** none · **Wave:** 1 · **Migrations:** `07xx`
- **Spec:** [auth-clerk.md](auth-clerk.md), ADR 0004.
- **Owns:** `apps/backend/crates/api/src/auth/**`, auth parts of `store/**`, `07xx` migrations,
  auth sections of the OpenAPI file, `taphoa-seed` user creation, `packages/e2e/src/helpers.ts`
  and `tests/auth.test.ts`, `tests/members.test.ts`, mobile `(onboarding)/**`, new `(auth)/**`
  routes, `features/onboarding/**`, `features/account/**`, the session store and the api-client
  auth wiring, Maestro and Playwright sign-in flows.
- **Touches:** every module's tests that build an `Actor` (constructor change only); root
  `_layout.tsx` (provider and gate).
- **Tasks:** JWKS verifier and `Actor` resolution with `X-Store-Id`; migration `0701` with the
  data reset; createStore/joinStore/getMe/PIN verify; remove legacy endpoints and `JWT_SECRET`
  use; Clerk Expo integration with own screens, Google SSO, multi-session switcher and PIN lock;
  harness helpers through the Clerk Backend API; seed users; reset `test` and `production` data
  and reseed; GitHub secrets for CI.
- **Acceptance:** auth-clerk.md "Tests"; full existing e2e suite green on Railway `test` with
  Clerk; Maestro sign-in + switch flow; Playwright sign-in flow; DoD row 5.
- **User input:** multi-session toggle in the Clerk dashboard before the multi-session e2e task
  (ask the user directly if still off; build and unit-test everything else first).
- **Coordinate:** X2 adds one call in the `Actor` extractor that records identity attributes on
  the span; keep it when rebasing. Merge as early as possible: every e2e spec depends on the
  helpers.
- **Out of scope:** Clerk production instance, phone sign-in, Clerk Organizations, webhooks.

---

## X2 · Observability platform and backend OpenTelemetry

- **Branch:** `epic/x2-observability` · **Depends:** none · **Wave:** 1
- **Spec:** [telemetry-contract.md](telemetry-contract.md), ADR 0006.
- **Owns:** `infra/otel-collector/**` (config, Dockerfile, README), `infra/langfuse/**` (setup
  and bootstrap scripts, notes), `apps/backend/crates/api/src/telemetry.rs`, telemetry init in
  `main.rs`, `TraceLayer` and context extraction in `lib.rs`, OTel crates in `Cargo.toml`,
  `.railway/railway.ts` variable additions, `.env.example`, a "Telemetry" section in
  `docs/deploy.md`.
- **Touches:** `auth/actor.rs` (one call recording identity attributes), DB/Redis/S3 client
  wrappers for client spans, `events/relay.rs` and `retention.rs` job spans.
- **Tasks:**
  1. Langfuse v3 stack in Railway `production` (web, worker, ClickHouse with volume, Postgres,
     Redis, S3-compatible storage; prefer a Railway Bucket over MinIO if Langfuse supports it),
     headless init (`LANGFUSE_INIT_*`: org, project `taphoa`, API keys, admin user = the account
     email, generated password kept as a Railway variable), public domain. Check the current
     Langfuse self-hosting docs and the Railway template before choosing.
  2. Verify with `railway config plan` that `.railway/railway.ts` does not try to delete the new
     services in either environment; extend the file or document why not.
  3. OTel Collector service (contrib image pinned) with OTLP/HTTP receiver, bearer auth,
     redaction, routing per the contract, exporters to Langfuse and PostHog; private endpoint
     for production, public domain for `test`.
  4. Backend telemetry module: tracer and logger providers, OTLP/HTTP exporter, resource
     attributes, W3C propagation, identity recording, DB/Redis/S3/job spans, graceful flush on
     shutdown, disabled when no endpoint is configured.
  5. Railway variables for `test` and `production`; put Langfuse keys into
     `~/.config/taphoa-mini/secrets.env` and GitHub secrets (`LANGFUSE_BASE_URL`,
     `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`).
- **Acceptance:** Rust tests with in-memory exporters assert every required attribute in the
  contract for an HTTP request, an authenticated request, a DB call and a job; collector config
  test (`otelcol validate`) in CI; on Railway `test`, a request produces a PostHog log line with
  `trace_id` and identity, and a synthetic `gen_ai` span reaches Langfuse (query the Langfuse
  API); Langfuse UI login works.
- **Out of scope:** assistant spans (X3), product events and dashboards (X6, X9), OTel metrics.

---

## X5 · Debt book

- **Branch:** `epic/x5-debt-book` · **Depends:** none (assistant tools wait for X3) · **Wave:** 1
  · **Migrations:** `09xx`
- **Spec:** [debt-book.md](debt-book.md).
- **Owns:** debt sections of the OpenAPI/AsyncAPI files, new `apps/backend/crates/api/src/debts/**`,
  `09xx` migrations, credit changes in `sales/**` and day-close changes in `reports/day_close.rs`,
  `RecordDebt`/`AdjustDebt` in `auth/permissions.rs`, mobile `features/debts/**`, the pay sheet
  credit option, debt dashboard card, `packages/e2e/tests/debts.test.ts`, debt Maestro and
  Playwright flows, change-feed entries for customers and debt entries.
- **Tasks:** contract; migration; customers and ledger with FIFO aging; credit sale and void
  reversal; repayments and adjustments; day-close expected cash; events and change feed; mobile
  pay sheet, picker, debt book and customer screens, reminder share; last: assistant tools,
  `overdue_debts` next-step rule and U23 golden cases once X3's registry is on `main`.
- **Acceptance:** debt-book.md "Tests"; DoD row 6; U23 golden cases pass in the smoke run.
- **Coordinate:** X1 may land first and change the `Actor`; rebase. X4 owns the next-step strip
  UI; X5 only adds the server rule.
- **Out of scope:** interest, debt due dates, SMS sending, customer accounts.

---

## X3 · Assistant backend

- **Branch:** `epic/x3-assistant-backend` · **Depends:** X0 · **Wave:** 2 · **Migrations:** `08xx`
- **Spec:** [assistant.md](assistant.md), ADR 0005, assistant spans in the
  [telemetry contract](telemetry-contract.md).
- **Owns:** `apps/backend/crates/api/src/assistant/**` (loop, OpenRouter chat client, tool
  registry, tools, actions, threads, SSE, next steps, quota, prompts, help articles, tax rule
  table), `08xx` migrations, `tests/assistant*.rs`, `packages/e2e/tests/assistant.test.ts`,
  assistant variables in `.railway/railway.ts`.
- **Touches:** `lib.rs` router merge; new read-only `pub(crate)` query functions in other modules
  (add new files, do not change existing handlers); `decisions.rs` only to share HTTP client code.
- **Tasks:** model client with tool calling and fallback list (check current OpenRouter docs for
  tool calling, streaming and model fallback routing); scripted mock model client for tests;
  tool registry with permission filtering; all tools except debt tools; proposed-action
  lifecycle with idempotent confirm through existing service functions; SSE stream; threads and
  feedback (feedback and action outcomes become Langfuse scores); next-steps rules (except
  `overdue_debts`, `digest`); quota; eval headers; GenAI spans per the contract; Vietnamese
  prompts and help articles; tax rule table from current regulation with sources.
- **Acceptance (tests first):** unit tests per tool against seeded fixtures; loop tests with the
  scripted model (parallel tool calls, max steps, fallback on 429/timeout/bad JSON, quota,
  permission-filtered tool list, injection text passed only as data); action tests (confirm
  executes once, replay, stale 409, seller denied); span tests with the in-memory exporter;
  next-steps p95 < 50 ms on the seed; e2e on Railway `test` with a real free model (≤ 30
  requests); smoke golden set passes once X7's harness exists.
- **User input:** a non-expiring OpenRouter key before 2026-11-23 (ask the user if still missing
  when you deploy production).
- **Out of scope:** mobile UI, digest job and push (X8), debt tools (X5), paid models.

---

## X4 · Assistant mobile

- **Branch:** `epic/x4-assistant-mobile` · **Depends:** X0 · **Wave:** 2
- **Spec:** [assistant.md](assistant.md) "Mobile UI", "Next-step strip"; `apps/mobile/AGENTS.md`.
- **Owns:** `apps/mobile/src/features/assistant/**`, `components/assistant/**`, the chat button,
  the next-step strip component, assistant React Query hooks, i18n strings, Jest tests,
  `e2e-web/assistant.spec.ts`, `.maestro/assistant*.yaml`.
- **Touches:** `features/inventory/ShopTabBar.tsx` or `(shop)/_layout.tsx` (chat button slot),
  `features/camera/CameraScreen.tsx` (strip slot under the frame and the receipt chip), receipt
  screen link back for "Xem dạng bảng".
- **Tasks:** check current Expo docs for streaming fetch (`expo/fetch`) and choose the speech
  recognition library for SDK 58; chat sheet and thread list; streaming renderer with tool
  status, cards and proposed-action cards; feedback; voice hold-to-talk; next-step strip with
  on-device chips; receipt-in-chat flow; analytics calls through `lib/analytics.ts`; feature
  flag hook (default on until X6 wires PostHog).
- **Acceptance (tests first):** Jest for every component and the receipt-chat state machine
  against the mock; Playwright web flow (open chat, ask, see streamed answer, confirm an action)
  and Maestro Android flow (chip opens chat, voice button visible, receipt chat confirm) against
  Railway `test`; DoD rows 1 and 3.
- **Out of scope:** backend, push, debt screens (X5), PostHog SDK wiring (X6).

---

## X7 · Golden set and evaluation

- **Branch:** `epic/x7-golden-set` · **Depends:** X0 (final runs need X3, U23 needs X5) · **Wave:** 2
- **Spec:** [golden-set.md](golden-set.md).
- **Owns:** `packages/eval/**`, `seed/eval.rs` (eval profile in `taphoa-seed`, separate file),
  oracle SQL, a CI job `assistant-eval-smoke` in `ci.yml`, `.github/workflows/eval.yml`
  (nightly + manual), `packages/eval/results/model-choice.md`.
- **Tasks:** eval store seed; case files (Vietnamese, about 140); oracle queries; scorers and
  judge with calibration; Langfuse dataset sync, runs and scores (check the current Langfuse JS
  SDK); quota guard; smoke in CI; nightly workflow; model comparison across current free
  tool-capable models; set `ASSISTANT_MODELS` on Railway from the result.
- **Acceptance:** scorer unit tests (number normalization, tool matching, leak detection) first;
  harness dry run with a stub assistant; after X3 merges, full run meets the pass bars with the
  chosen model and shows in Langfuse as a dataset run; DoD row 4.
- **Coordinate:** before X3 merges, build and test everything against the X0 mock contract and
  a stub; then wait for X3 and run. Report misses to the program controller with the failing case
  ids so X3 can fix prompts or tools.
- **Out of scope:** changing assistant code (send findings to X3).

---

## X6 · Product analytics (PostHog)

- **Branch:** `epic/x6-product-analytics` · **Depends:** X1, X2 · **Wave:** 2 (after X1 and X2
  merge)
- **Spec:** product events and session replay in the [telemetry contract](telemetry-contract.md);
  PostHog section of [dashboards.md](dashboards.md).
- **Owns:** PostHog implementation behind `apps/mobile/src/lib/analytics.ts`, provider in the
  root layout, identify and `store` group after sign-in, screen tracking, replay masking, error
  tracking, `assistant_enabled` flag hook, `X-POSTHOG-SESSION-ID` and `traceparent` headers in
  the api-client; backend PostHog client behind `analytics.rs` and the outbox-to-product-event
  mapping in the relay; `infra/posthog/**` (project settings, group type, dashboards, insights,
  playlists, flag, saved log views as idempotent code using the personal API key from the local
  secrets file).
- **Tasks:** check the current `posthog-react-native` and PostHog API docs; wire app events that
  X4 and X5 already call; add missing app events from the contract; backend events from outbox;
  dashboards as code; verify each insight returns data on `test`.
- **Acceptance:** Jest tests that each contract event is captured with required properties and no
  forbidden ones; Rust tests for the outbox mapping; script dry-run tests; on `test`, every
  PostHog dashboard in dashboards.md shows data (API query per insight); DoD row 8 except final
  screenshots.
- **Out of scope:** Langfuse dashboards (X9), marketing site analytics.

---

## X8 · Push notifications and daily digest

- **Branch:** `epic/x8-push-digest` · **Depends:** X3 · **Wave:** 3 · **Migrations:** `10xx`
- **Spec:** U13 in [assistant.md](assistant.md); devices and digest endpoints in its contract.
- **Owns:** `apps/backend/crates/api/src/assistant/digest/**`, `devices` module, `10xx`
  migrations, Expo push sender, digest job, mobile notifications setup (`expo-notifications`,
  permission prompt timing, token registration, deep link to the digest and assistant), digest
  card on the dashboard, `digest` next-step rule, EAS file variable for `google-services.json`.
- **Tasks:** check current Expo notifications and EAS FCM V1 docs; device registration; digest
  generation at 07:00 `Asia/Ho_Chi_Minh` per store (model-written with a template fallback,
  cached per store and business date, one model call per store per day); push send with Expo
  receipts handling and token cleanup; app card and deep links.
- **Acceptance:** Rust tests for scheduling, caching, fallback and receipt handling with a mock
  push API; Jest for registration and card; on `test`, a digest is generated and an Expo push
  ticket and receipt are `ok` for a registered Android build.
- **User input:** FCM V1 service account uploaded to EAS and `google-services.json`; ask the user
  if missing when you reach the push task (build the digest and card first).
- **Out of scope:** iOS push credentials, marketing notifications.

---

## X9 · Dashboards, integration and DoD validation

- **Branch:** `epic/x9-dashboards-dod` · **Depends:** all · **Wave:** 4
- **Spec:** [dashboards.md](dashboards.md), README "Definition of done".
- **Owns:** `infra/langfuse/dashboards/**`, Langfuse model definitions, online evaluator setup,
  `docs/specs/assistant/dod-report.md`, screenshots under `docs/specs/assistant/dod/`.
- **Tasks:** build every Langfuse dashboard and chart; configure the online judge; drive real
  traffic on `test` (full e2e, eval smoke, Maestro and Playwright flows) and production smoke;
  verify every Langfuse and PostHog chart shows data through their APIs; capture screenshots
  (Claude in Chrome or Playwright); walk DoD rows 1-10 and record evidence; fix small gaps or
  send them to the owning epic through the program controller; confirm production deploy; clean
  up all program worktrees per `AGENTS.md`.
- **Acceptance:** `dod-report.md` with evidence for every DoD row, no open gap.
