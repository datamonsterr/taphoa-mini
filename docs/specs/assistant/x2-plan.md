# X2 plan: observability platform and backend OpenTelemetry

Status: Done · Merge: [#33](https://github.com/datamonsterr/taphoa-mini/pull/33) · Date: 2026-10-25 · Epic: [X2](epics.md) · Contract:
[telemetry-contract.md](telemetry-contract.md) · ADR [0007](../../adr/0007-posthog-only-observability.md)
(supersedes 0006)

## Scope change (2026-10-25)

The owner dropped self-hosted Langfuse: PostHog Cloud US is the only telemetry destination.
The collector routes all traces and all logs to PostHog. Assistant LLM observability moves to
PostHog LLM analytics `$ai_*` events, which X3 emits through the backend PostHog client; X2
builds nothing for it. The Langfuse stack X2 created in Railway `production` (services
`langfuse-web`, `langfuse-worker`, `langfuse-clickhouse`, `langfuse-postgres`,
`langfuse-redis`, their three volumes and the bucket `langfuse`) and the `LANGFUSE_*` secrets
are deleted by the program controller after the collector stops referencing them.

## Version pins and docs checked (2026-10-25)

| Component      | Pin                                                                                                                             | Why                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OTel Collector | `otel/opentelemetry-collector-contrib:0.163.2`                                                                                  | Latest contrib release (component modules v0.163.0); `bearertokenauth`, `transform`, `resource`, `otlp_http` (current name of `otlphttp`).                         |
| Rust crates    | `opentelemetry`, `opentelemetry_sdk`, `opentelemetry-otlp`, `opentelemetry-appender-tracing` 0.33; `tracing-opentelemetry` 0.34 | Matching set (tracing-opentelemetry 0.34 depends on opentelemetry 0.33). Appender feature `experimental_span_attributes` copies allowlisted span fields onto logs. |

Docs read: PostHog logs (`/i/v1/logs`) and tracing (`/i/v1/traces`, beta) with
`Authorization: Bearer <project token>`; collector-contrib transform, redaction, resource and
bearertokenauth READMEs; crates.io metadata and docs.rs for the Rust crates; the `railway` IaC
SDK 3.16 (`defineRailway((ctx) => …)` with `ctx.isEnvironment(name)`).

## Design decisions

- **One collector.** OTLP/HTTP on port 4318 with bearer auth, redaction (authorization,
  cookie, `*.token`, `*.secret` attributes; 9-15 digit runs in log bodies), resource
  environment default, batch, then PostHog traces and logs with retry and a sending queue.
- **Identity on spans and logs.** The `Actor` extractor makes one call,
  `telemetry::record_identity(...)`, which records the identity fields on the request span.
  Logs get them through the appender's span-attribute allowlist; child spans get them from the
  telemetry module (inherited from the request span), so feature code does nothing.
- **DB spans** come from sqlx's own `sqlx::query` events, turned into `db {operation} {table}`
  client spans by a small layer, only inside an active span. No call site changes; statement
  text is never exported.
- **Per-environment infrastructure.** `.railway/railway.ts` declares the collector only when
  `ctx.isEnvironment('production')`, so `test` plans never create it and `production` plans
  never delete it. Secrets stay `preserve()`.
- **Existing IaC drift is not ours.** The baseline plan (before X2) already wants to delete
  buckets (`images-prod` in production, `images` and `images-sjc` in test), move volume
  regions `sfo` to `sin`, and drop the Clerk variables. X2 never runs `railway config apply`;
  it creates services with the CLI and mirrors them in the file. X2 adds `preserve()` for the
  PostHog and OTel variables it owns and reports the rest to the program controller.
- **Service version.** `SERVICE_VERSION` env, which the deploy workflow sets to the deployed
  SHA as a Railway variable before `railway up`; else `RAILWAY_GIT_COMMIT_SHA`; else an
  optional local `.service-version` file read from the working directory; else the crate
  version.

## Task graph

```
T1 backend telemetry ─────────────┐
T2 collector config + tests + CI ─┼─▶ T5 deploy collector ─▶ T6 variables ─▶ T7 test-env proof ─▶ T8 review, merge, deploy, cleanup
T4 railway.ts + docs ─────────────┘
T9 remove Langfuse (scope change) ─▶ T5 redeploy collector PostHog-only
```

| ID  | Task                                                                                                                                                                                                               | Owner                 | Tests first                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------- |
| T1  | `telemetry.rs`: providers, OTLP/HTTP exporter, resource, W3C propagation, request span + access log, error code, identity, DB/Redis/S3/OpenRouter client spans, job spans, flush on shutdown, off without endpoint | worker, then subagent | `apps/backend/crates/api/tests/telemetry.rs` with in-memory span and log exporters |
| T2  | `infra/otel-collector/` config, Dockerfile, README; redaction, bearer auth; `otelcol validate` and a routing test in CI                                                                                            | worker                | `infra/otel-collector/tests/test_routing.py` (collector in Docker, JSON sinks)     |
| T3  | Langfuse stack in Railway `production` (dropped by the scope change)                                                                                                                                               | controller            | n/a                                                                                |
| T4  | `.railway/railway.ts` production-only collector and X2 variables; "Telemetry" section in `docs/deploy.md`                                                                                                          | worker                | `railway config plan` for both environments shows no X2 drift                      |
| T5  | Deploy `otel-collector` (production, private endpoint + public domain for `test`)                                                                                                                                  | controller            | 401 without token, 200 with token on `/v1/logs`                                    |
| T6  | Railway variables (`OTEL_EXPORTER_OTLP_*`, collector secrets)                                                                                                                                                      | controller            | `railway variable list --json` (names only)                                        |
| T7  | Branch deploy to `test`; PostHog log with `trace_id` and identity                                                                                                                                                  | controller            | PostHog API query recorded below                                                   |
| T8  | Review (`/code-review`), `ci-ok`, merge commit, `Deploy backend` to production smoke, worktree cleanup                                                                                                             | controller            | `gh pr view`, workflow run                                                         |
| T9  | Remove Langfuse from the collector, IaC, docs and backend resource attributes                                                                                                                                      | subagents             | collector routing test (PostHog only), `railway config plan`                       |

## Evidence

- **T5 collector.** `otel-collector` is deployed (contrib 0.163.2) with private endpoint
  `otel-collector.railway.internal:4318` and public domain
  `https://otel-collector-production-ce86.up.railway.app`. OTLP `/v1/logs` returns 401 without
  a token or with a wrong token, 200 with the collector token. Before the scope change a
  synthetic trace sent to the public domain was exported without errors to both destinations.
- **T6 variables.** Backend `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` are
  set in both environments (production through references to the collector, test as a literal
  public URL and header); collector PostHog variables reference the backend PostHog variables.
- **Deploy note.** From a worktree under `.claude/worktrees/`, `railway up` resolves the main
  checkout and its ignore rules drop the worktree; use `railway up . --path-as-root`.
- **IaC plans (after the Langfuse stack was deleted).** `railway config plan` lists no X2
  resource or variable in either environment; the collector is neither created in `test` nor
  deleted in `production`. Remaining lines are the pre-existing drift: production
  `+ backend.OCR_THREADS`, Clerk variable deletes, backend `source.*` and
  `restartPolicyType`, `redis-volume`/`postgres-volume` region `sfo`→`sin`,
  `- bucket images-prod`; test `+ backend.SAM_DECODERS`, Clerk variable deletes,
  `restartPolicyType`, the two volume regions, `+ bucket images-sin`, `- bucket images`,
  `- bucket images-sjc`.

- **T7 test-env proof (2026-10-25).** Branch validation run 40184209575 (`deploy.yml` on
  Railway `test`): 66 e2e tests passed, `/readyz` p95 83 ms. An authenticated
  `GET /v1/reports/today` with a known `traceparent` produced, in PostHog project 682994:
  a `logs` row `request completed` (INFO) with that `trace_id`, its `span_id`, `http.route`,
  status, duration, `taphoa.store.id`, `taphoa.member.id`, `taphoa.member.role`, `session.id`
  and `posthog.session_id`, resource `service.name=taphoa-backend`,
  `deployment.environment.name=test`; and `posthog.trace_spans` rows for the server span
  `GET /v1/reports/today` (parented to the incoming `traceparent`, same identity attributes)
  with `db SELECT sessions` and `db SELECT` children. Queried with HogQL
  (`SELECT … FROM logs` / `FROM posthog.trace_spans WHERE trace_id = …`); ingestion lag about
  4 minutes.
- **Readyz tail diagnosed with the new traces.** An earlier validation (run 40181638165) passed
  all e2e tests but failed the `/readyz` p95 probe (504 ms vs 500 ms). Over 40 minutes of `test`
  traces the server span was p50 11.7 ms / max 437 ms, and the time sat in the child
  `s3 HeadBucket` span (max 437 ms) while `db SELECT` stayed under 12 ms: storage latency,
  not telemetry overhead.

## Review notes (deferred, with reasons)

- `user.id` is not recorded and `session.id` is the internal session UUID until X1 lands the
  Clerk `Actor`; X1 maps `user.id = clerk_user_id` and `session.id = sid` inside
  `telemetry::record_identity`.
- `db.collection.name` is omitted when the main table cannot be parsed safely (CTEs,
  dollar-quoted literals); the contract's required attribute applies when the table is known.
- `recognition.scan` spans are not emitted by X2 (not in the X2 acceptance); follow-up for the
  owning epic.
- Background tasks (outbox relay, retention, index worker) are still only observed at
  shutdown, as before X2; supervision is a separate follow-up.
- Collector redaction keeps `error_mode: ignore` (a failing statement must not drop whole
  batches); its statements cannot fail on valid input.
