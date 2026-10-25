# X2 plan: observability platform and backend OpenTelemetry

Status: In progress · Date: 2026-10-25 · Epic: [X2](epics.md) · Contract:
[telemetry-contract.md](telemetry-contract.md) · ADR [0006](../../adr/0006-telemetry-routing.md)

## Version pins and docs checked (2026-10-25)

| Component                 | Pin                                                                                                                             | Why                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Langfuse web / worker     | `langfuse/langfuse:4.70.0`, `langfuse/langfuse-worker:4.70.0`                                                                   | v4 is GA and the current self-hosting line; v3 gets security fixes only until 2027-01, and current Langfuse SDKs (Python v5, JS v6, used by X7) need a v4 server.  |
| ClickHouse                | `clickhouse/clickhouse-server:26.4.5`                                                                                           | Langfuse v4 needs 25.12+, recommends 26.4. Single node, `CLICKHOUSE_CLUSTER_ENABLED=false`, UTC.                                                                   |
| Langfuse Postgres / Redis | Railway Postgres (15+) and Railway Redis (7+)                                                                                   | v4 minimums: Postgres 15, Redis 7.                                                                                                                                 |
| Langfuse blob storage     | Railway Bucket `langfuse` (S3-compatible, region `sin`)                                                                         | Langfuse supports any S3-compatible store (`LANGFUSE_S3_*`); a Railway Bucket avoids running MinIO.                                                                |
| OTel Collector            | `otel/opentelemetry-collector-contrib:0.163.2`                                                                                  | Latest contrib release; filter processor `trace_conditions` syntax, `bearertokenauth`, `basicauth`, `transform`.                                                   |
| Rust crates               | `opentelemetry`, `opentelemetry_sdk`, `opentelemetry-otlp`, `opentelemetry-appender-tracing` 0.33; `tracing-opentelemetry` 0.34 | Matching set (tracing-opentelemetry 0.34 depends on opentelemetry 0.33). Appender feature `experimental_span_attributes` copies allowlisted span fields onto logs. |

Not chosen: the Railway Langfuse template (`exma_H`) deploys Langfuse v3 with its own storage
choices; the Langfuse docs say no v4 template exists yet.

Docs read: Langfuse self-hosting overview, configuration, headless initialization, blob storage,
ClickHouse, v3 to v4 upgrade guide, OpenTelemetry ingestion (`/api/public/otel`, Basic auth,
`x-langfuse-ingestion-version: 4`, HTTP only); PostHog logs (`/i/v1/logs`) and tracing
(`/i/v1/traces`, beta) with `Authorization: Bearer <project token>`; collector-contrib filter,
transform, redaction and bearertokenauth READMEs; crates.io metadata for the Rust crates; the
`railway` IaC SDK 3.16 (`defineRailway((ctx) => …)` with `ctx.isEnvironment(name)`).

## Design decisions

- **Langfuse trace roots.** The collector sends only assistant spans to Langfuse, so their HTTP
  parent span is missing there. The Langfuse pipeline clears `parent_span_id` on
  `invoke_agent` spans: each assistant turn is a Langfuse root while its `trace_id` stays the
  same as the PostHog trace. The pipeline also copies `deployment.environment.name` into
  `langfuse.environment` when the span lacks it.
- **Identity on spans and logs.** The `Actor` extractor makes one call,
  `telemetry::record_identity(...)`, which records the identity fields on the request span.
  Logs get them through the appender's span-attribute allowlist; child spans get them from the
  telemetry module (inherited from the request span), so feature code does nothing.
- **DB spans** come from sqlx's own `sqlx::query` events, turned into `db {operation} {table}`
  client spans by a small layer. No call site changes; statement text is never exported.
- **Per-environment infrastructure.** `.railway/railway.ts` declares the Langfuse stack and
  the collector only when `ctx.isEnvironment('production')`, so `test` plans never create them
  and `production` plans never delete them. Secrets stay `preserve()`.
- **Existing IaC drift is not ours.** The baseline plan (before X2) already wants to delete
  buckets (`images-prod` in production, `images` and `images-sjc` in test), move volume
  regions `sfo` to `sin`, and drop the Clerk variables. X2 never runs `railway config apply`;
  it creates services with the CLI and mirrors them in the file. X2 adds `preserve()` for the
  PostHog and OTel variables it owns and reports the rest to the program controller.
- **Service version.** `SERVICE_VERSION` env, else `RAILWAY_GIT_COMMIT_SHA`, else a
  `.service-version` file the deploy workflow writes before `railway up`, else the crate
  version.

## Task graph

```
T1 backend telemetry ─────────────┐
T2 collector config + tests + CI ─┼─▶ T5 deploy collector ─▶ T6 variables ─▶ T7 test-env proof ─▶ T8 review, merge, deploy, cleanup
T3 Langfuse stack (CLI) ──────────┘                ▲
T4 railway.ts + docs + .env.example (after T3) ────┘
```

| ID  | Task                                                                                                                                                                                                               | Owner                      | Tests first                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------- |
| T1  | `telemetry.rs`: providers, OTLP/HTTP exporter, resource, W3C propagation, request span + access log, error code, identity, DB/Redis/S3/OpenRouter client spans, job spans, flush on shutdown, off without endpoint | worker (superorchestrator) | `apps/backend/crates/api/tests/telemetry.rs` with in-memory span and log exporters          |
| T2  | `infra/otel-collector/` config, Dockerfile, README; routing, redaction, bearer auth; `otelcol validate` and a routing test in CI                                                                                   | worker (superorchestrator) | `infra/otel-collector/tests/test_routing.py` (collector in Docker, JSON sinks)              |
| T3  | Langfuse v4 stack in Railway `production`: web, worker, ClickHouse + volume, Postgres, Redis, bucket; headless init; public domain                                                                                 | controller (CLI only)      | Langfuse `/api/public/health`, UI login, API key check                                      |
| T4  | `.railway/railway.ts` production-only resources and X2 variables; `.env.example`; "Telemetry" section in `docs/deploy.md`; `infra/langfuse/` notes and bootstrap script                                            | worker (native subagent)   | `railway config plan` for both environments shows no X2 resource deletion or creation drift |
| T5  | Deploy `otel-collector` (production, private endpoint + public domain for `test`)                                                                                                                                  | controller                 | 401 without token, 200 with token on `/v1/logs`                                             |
| T6  | Railway variables (`OTEL_EXPORTER_OTLP_*`, collector secrets); Langfuse keys into local secrets file and GitHub secrets                                                                                            | controller                 | `gh secret list`, `railway variable list --kv` (names only)                                 |
| T7  | Branch deploy to `test`; PostHog log with `trace_id` and identity; synthetic `gen_ai` span through the Langfuse API                                                                                                | controller                 | PostHog and Langfuse API queries recorded below                                             |
| T8  | Review (`/code-review`), `ci-ok`, merge commit, `Deploy backend` to production smoke, worktree cleanup                                                                                                             | controller                 | `gh pr view`, workflow run                                                                  |

## Evidence

- **T3 Langfuse (2026-10-25).** Langfuse v4.70.0 runs in Railway `production` at
  <https://langfuse-web-production-dac5.up.railway.app>: `/api/public/health` returns
  `{"status":"OK","version":"4.70.0"}`; the admin credentials login returns a session with org
  `taphoa`; the project API keys list project `taphoa`. Keys are in the local secrets file and
  GitHub secrets `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`. Services were
  created with the CLI in `production` only; `test` still has only `backend`, `Postgres`, `Redis`.
- **T5 collector.** `otel-collector` is deployed (contrib 0.163.2) with private endpoint
  `otel-collector.railway.internal:4318` and public domain
  `https://otel-collector-production-ce86.up.railway.app`. OTLP `/v1/logs` returns 401 without
  a token or with a wrong token, 200 with the collector token.
- **Synthetic `gen_ai` span.** A synthetic trace (HTTP root, `invoke_agent taphoa-assistant`
  child, `chat` generation) sent to the public collector domain with environment `test` appears
  in Langfuse within 6 s through `/api/public/v2/observations?traceId=…`: the `invoke_agent`
  span is an `AGENT` root observation and `chat` a `GENERATION` child, both with environment
  `test`; the HTTP span is not sent to Langfuse. The collector logged no export errors to
  Langfuse or PostHog.
- **T6 variables.** Backend `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` are
  set in both environments (production through references to the collector, test as a literal
  public URL and header); collector variables reference `langfuse-web` keys and the backend
  PostHog variables.
- **Deploy note.** From a worktree under `.claude/worktrees/`, `railway up` resolves the main
  checkout and its ignore rules drop the worktree; use `railway up . --path-as-root`.
