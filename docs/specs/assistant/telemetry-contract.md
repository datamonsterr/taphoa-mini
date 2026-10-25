# Telemetry contract

Status: Accepted · Date: 2026-10-25 · Program: [README](README.md) · ADR
[0006](../../adr/0006-telemetry-routing.md) · Epics: X2 (backend, collector), X3 (assistant
spans), X6 (product events)

This file is the source of truth for span, log and product-event names and attributes. Contract
tests (in-memory exporters) assert the required attributes. Check the current OpenTelemetry
semantic conventions and the Langfuse and PostHog ingestion docs before coding; when a
convention has moved, follow the current one and update this file in the same PR.

## Pipeline

```
mobile app ── posthog-react-native ───────────────────────────────▶ PostHog Cloud US
    │  traceparent + X-POSTHOG-SESSION-ID headers on every API call
    ▼
backend (tracing → tracing-opentelemetry, opentelemetry-appender-tracing)
    │ OTLP/HTTP  (production: private network; test: public domain + bearer token)
    ▼
otel-collector (Railway production)
    ├─ traces where scope = taphoa.assistant or gen_ai.operation.name present ─▶ Langfuse /api/public/otel
    ├─ all traces ──────────────────────────────────────────────────────────▶ PostHog tracing (when its OTLP intake is available)
    └─ all logs ────────────────────────────────────────────────────────────▶ PostHog logs (/i/v1/logs)
backend ── server-side business events (posthog capture API) ───────────────▶ PostHog Cloud US
eval harness ── Langfuse SDK (datasets, runs, scores) ──────────────────────▶ Langfuse
```

Collector processors: `memory_limiter`, `batch`, an attribute redaction step (drop
`http.request.header.authorization`, `cookie`, any `*.token`, `*.secret`; mask 9-15 digit
sequences in log bodies), and `resource` defaults. Exporters retry with backoff; the backend
never blocks a request on export.

## Resource attributes (every signal)

| Attribute                     | Value                                            |
| ----------------------------- | ------------------------------------------------ |
| `service.name`                | `taphoa-backend`, `taphoa-mobile`, `taphoa-eval` |
| `service.version`             | git SHA (`RAILWAY_GIT_COMMIT_SHA` or build arg)  |
| `deployment.environment.name` | `production`, `test`, `eval`, `local`            |

Langfuse reads the environment from its own attribute (`langfuse.environment`) when the
resource attribute is not mapped; set both.

## Identity attributes (every span and log inside an authenticated request)

| Attribute            | Value                    |
| -------------------- | ------------------------ |
| `user.id`            | Clerk user id            |
| `taphoa.store.id`    | store UUID               |
| `taphoa.member.id`   | member UUID              |
| `taphoa.member.role` | `lead` or `seller`       |
| `session.id`         | Clerk session id (`sid`) |

Recorded by the `Actor` extractor on the request span; child spans and logs inherit through the
span context (logs carry `trace_id` and `span_id`). Unauthenticated requests carry none.
Forbidden everywhere: names, emails, phone numbers, bank account numbers, customer data, OCR
text, tokens, keys.

## Backend spans

| Span                             | Required attributes                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| HTTP server (`{method} {route}`) | `http.request.method`, `http.route`, `http.response.status_code`, `url.path` (no query), identity, `taphoa.error.code` on errors |
| Incoming context                 | extract W3C `traceparent` / `tracestate`; copy `X-POSTHOG-SESSION-ID` to `posthog.session_id`                                    |
| DB (`db {operation} {table}`)    | `db.system.name=postgresql`, `db.operation.name`, `db.collection.name` (no statement text with values)                           |
| Redis, S3, OpenRouter decisions  | client spans with `server.address`, outcome                                                                                      |
| Recognition (`recognition.scan`) | `taphoa.scan.purpose`, `taphoa.scan.detections`, `taphoa.scan.match_class`, timings per stage                                    |
| Background job (`job {name}`)    | `taphoa.job.name`, `taphoa.job.attempt`, outcome                                                                                 |

## Assistant spans (instrumentation scope `taphoa.assistant`)

Follow the OpenTelemetry GenAI conventions so Langfuse maps them to traces, generations and
tool observations.

| Span                            | Kind     | Required attributes                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invoke_agent taphoa-assistant` | internal | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=taphoa-assistant`, `langfuse.trace.name=assistant.turn`, `langfuse.user.id`, `langfuse.session.id` (= thread id), `langfuse.trace.tags` (use-case tags), `langfuse.trace.metadata.store_id`, `langfuse.trace.metadata.role`, `langfuse.trace.metadata.screen`, `langfuse.observation.input` (user text), `langfuse.observation.output` (final text), `langfuse.environment` |
| `chat {model}`                  | client   | `gen_ai.operation.name=chat`, `gen_ai.provider.name=openrouter`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, input and output messages (current GenAI message attributes), `taphoa.assistant.fallback_index`, time to first token                                                                                                  |
| `execute_tool {tool}`           | internal | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `taphoa.tool.kind` (read, propose), `taphoa.tool.ok`, `taphoa.tool.rows`, `taphoa.tool.denied`                                                                                                                                                                                                                                                      |
| `assistant.action {kind}`       | internal | `taphoa.action.id`, `taphoa.action.kind`, `taphoa.action.status` (confirmed, rejected, expired, failed); linked to the proposing trace with a span link                                                                                                                                                                                                                                                                              |
| `assistant.next_steps`          | internal | `taphoa.next_steps.count`, kinds                                                                                                                                                                                                                                                                                                                                                                                                     |

Langfuse scores (written through the Langfuse public API by the backend):

| Score            | Source                                        | Value                                                      |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `user_feedback`  | thumbs on a message                           | 1 or 0, comment                                            |
| `action_outcome` | proposed action decided                       | `confirmed`, `rejected`, `expired`, `failed` (categorical) |
| `quota_hit`      | turn ended by quota                           | 1                                                          |
| eval scores      | eval harness ([golden-set.md](golden-set.md)) | per scorer                                                 |

Use-case tags on `langfuse.trace.tags`: the use-case ids (`U1`..`U23`) whose tools ran in the
turn, plus `receipt_chat`, `voice`, `next_step:<kind>` when the turn started from a chip.

## Logs

- Every `tracing` event at `info` and above goes to PostHog logs with `trace_id`, `span_id`,
  severity, `target`, message and the identity attributes; `debug` stays local.
- Required structured fields: `taphoa.error.code` for API errors, `taphoa.job.name` for jobs.
- Request access log: one `info` line per request with route, status and duration.

## Metrics

No OTel metrics pipeline in this program. Langfuse computes LLM metrics from traces; PostHog
insights compute product and API metrics from events and logs.

## Product events (PostHog)

Names are `object_verb` in snake case. `distinct_id` is the Clerk user id; every event carries
the `store` group (store UUID) and properties `member_id`, `role`, `environment`, `app_version`,
`language`. Person properties set by the app on identify: `email`, `name`, `role`.

| Event                                             | Sent by | Properties                                                            |
| ------------------------------------------------- | ------- | --------------------------------------------------------------------- |
| `$screen`                                         | app     | `$screen_name` (auto)                                                 |
| `signed_in` / `signed_out`                        | app     | `method` (email_code, google)                                         |
| `account_switched`                                | app     | `with_pin`                                                            |
| `store_created`                                   | backend | none                                                                  |
| `member_joined`                                   | backend | `role`, `can_enroll`                                                  |
| `product_enrolled`                                | backend | `reference_count`, `source`                                           |
| `scan_completed`                                  | backend | `purpose`, `match_class`, `latency_ms`                                |
| `sale_completed`                                  | backend | `total`, `line_count`, `payment_method`, `has_credit`, `manual_lines` |
| `sale_voided`                                     | backend | `same_day`                                                            |
| `receipt_scanned`                                 | backend | `line_count`, `matched_lines`, `latency_ms`                           |
| `receipt_confirmed`                               | backend | `line_count`, `via` (chat, form)                                      |
| `stock_adjusted`                                  | backend | `reason`, `via` (manual, assistant)                                   |
| `expense_added`                                   | backend | `category`, `via`                                                     |
| `price_changed`                                   | backend | `via`                                                                 |
| `day_closed`                                      | backend | `difference_bucket` (zero, small, large)                              |
| `customer_created`                                | backend | none                                                                  |
| `debt_recorded` / `debt_repaid` / `debt_adjusted` | backend | `amount_bucket`, `method`                                             |
| `assistant_opened`                                | app     | `entry` (button, chip, receipt, digest, push)                         |
| `assistant_message_sent`                          | app     | `input` (text, voice), `thread_turn`                                  |
| `assistant_reply_received`                        | app     | `latency_ms`, `tools_count`, `error_code`                             |
| `assistant_action_proposed`                       | backend | `kind`                                                                |
| `assistant_action_decided`                        | backend | `kind`, `decision`                                                    |
| `assistant_feedback_given`                        | app     | `rating`                                                              |
| `next_step_shown` / `next_step_tapped`            | app     | `kind`, `position`                                                    |
| `digest_opened`                                   | app     | `entry` (card, push)                                                  |
| `voice_input_used`                                | app     | `duration_ms`, `language`, `ok`                                       |
| `$exception`                                      | app     | automatic error tracking                                              |

Backend events are emitted from the outbox relay (one capture per committed business event),
so they are never sent for rolled-back transactions. Amounts in events are buckets except
`sale_completed.total` (integer đồng, needed for revenue insights).

Session replay: on in the app with all text inputs masked, camera preview and product images
masked (`ph-no-capture` equivalents in the React Native SDK), network bodies not recorded.
