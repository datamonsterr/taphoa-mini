# Telemetry contract

Status: Accepted · Date: 2026-10-25 · Program: [README](README.md) · ADR
[0007](../../adr/0007-posthog-only-observability.md) · Epics: X2 (backend, collector), X3
(assistant spans and LLM events), X6 (product events)

This file is the source of truth for span, log and product-event names and attributes. Contract
tests (in-memory exporters) assert the required attributes. Check the current OpenTelemetry
semantic conventions and the PostHog ingestion and LLM analytics docs before coding; when a
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
    ├─ all traces ──────────────────────────────────────────────────────────▶ PostHog tracing (current OTLP traces intake)
    └─ all logs ────────────────────────────────────────────────────────────▶ PostHog logs (/i/v1/logs)
backend ── business events + LLM analytics ($ai_trace, $ai_span, $ai_generation) via capture API ──▶ PostHog Cloud US
eval harness ── eval_case_scored, eval_run_completed via capture API ──────▶ PostHog Cloud US
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

PostHog events (product and `$ai_*`) carry the same value as the `environment` property.

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

## Assistant spans (shared instrumentation scope `taphoa.backend`)

Spans follow the OpenTelemetry GenAI conventions and reach PostHog tracing through the collector,
so a slow turn can be followed into DB and tool spans.

| Span                            | Kind     | Required attributes                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke_agent taphoa-assistant` | internal | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=taphoa-assistant`, `gen_ai.conversation.id` (thread id), `taphoa.assistant.use_cases`, `taphoa.assistant.screen`, identity                                                                                                                                                                                  |
| `chat {model}`                  | client   | `gen_ai.operation.name=chat`, `gen_ai.provider.name=openrouter`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `taphoa.assistant.fallback_index`, `taphoa.assistant.time_to_first_token_ms`, `server.address`, `error.type` on failure (no message content on spans) |
| `execute_tool {tool}`           | internal | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `taphoa.tool.kind` (read, propose), `taphoa.tool.ok`, `taphoa.tool.rows`, `taphoa.tool.denied`                                                                                                                                                                                      |
| `assistant.action {kind}`       | internal | `taphoa.action.id`, `taphoa.action.kind`, `taphoa.action.status` (confirmed, rejected, expired, failed); linked to the proposing `execute_tool` span with both its trace id and span id                                                                                                                                                                              |
| `assistant.next_steps`          | internal | `taphoa.next_steps.count`, kinds                                                                                                                                                                                                                                                                                                                                     |

### Voice spans

| Span               | Kind     | Required attributes                                                                                                                                                                                                                             |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voice.utterance`  | internal | `voice.mode` (sale, transcribe), `voice.entry`, `voice.audio_seconds`, `voice.model`, `voice.stt_fallback`, `voice.intent` (sale, chat, none), `voice.lines`, `voice.matched`, `voice.ambiguous`, `voice.unknown`, `voice.latency_ms`, identity |
| `voice.model_call` | client   | child of `voice.utterance`; GenAI attributes as for `chat {model}` (`gen_ai.operation.name=chat`, `gen_ai.provider.name=openrouter`, models, token usage, finish reasons, `taphoa.assistant.fallback_index`, `error.type` on failure)           |

No transcript in span attributes (it may contain a customer name); the transcript lives only in
`voice_utterances`. Each model call also emits one `$ai_generation` event (see below) with
`$ai_session_id` = utterance id and cost from `usage.cost`.

Action links use nullable `assistant_actions.span_id` and `assistant_messages.span_id` (migration
`0804_assistant_span_ids.sql`). Proposals store the executing tool span id; messages without a
proposal retain the turn span id. Legacy rows without both valid ids have no link. The current
[GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/tree/main/docs/gen-ai)
retain `gen_ai.provider.name` and `gen_ai.response.finish_reasons` (a string array).

## Assistant LLM analytics events (PostHog)

Captured by the backend PostHog client after each turn (batched, never blocking the reply).
Every event: `distinct_id` = member id until X1 switches to Clerk user id, `$groups.store` = store id, properties `member_id`,
`role`, `environment`, `$ai_session_id` = thread id, `$ai_trace_id` = the OTel trace id (hex) of
the turn, so PostHog LLM traces and backend traces share one id. Check the current PostHog
manual-capture docs for property names before coding.

| Event            | When           | Required properties                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$ai_trace`      | one per turn   | `$ai_span_name=assistant.turn`, `$ai_input_state` (user text), `$ai_output_state` (final text), `$ai_latency`, `use_cases` (`U1`..`U23`), `entry` (button, chip, receipt, digest, push), `next_step_kind`, `prompt_version`, `eval_run_id` (eval only)                                                                                                                                                                                                                      |
| `$ai_generation` | per model call | `$ai_span_id`, `$ai_parent_id`, `$ai_model`, `$ai_provider=openrouter`, `$ai_input` (messages), `$ai_output_choices`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_latency`, `$ai_http_status`, `$ai_is_error`, `$ai_error`, `$ai_stop_reason`, `$ai_tools` (names only), `$ai_stream=true`, `fallback_index`, `$ai_time_to_first_token` (seconds), `time_to_first_token_ms`, `$ai_input_cost_usd`, `$ai_output_cost_usd`, `$ai_total_cost_usd` (all zero for free models) |
| `$ai_span`       | per tool call  | `$ai_span_id`, `$ai_parent_id`, `$ai_span_name=tool:<name>`, `$ai_input_state` (arguments), `$ai_output_state` (summary and row count, not full rows), `$ai_latency`, `$ai_is_error`, `tool_kind`, `denied`                                                                                                                                                                                                                                                                 |

Voice model calls (`voice.model_call`) emit one `$ai_generation` each with `$ai_input_tokens`,
`$ai_output_tokens`, `$ai_total_cost_usd` from `usage.cost`, `$ai_session_id` = utterance id,
`$ai_trace_id` = the `voice.utterance` trace id. Voice `$ai_input` and `$ai_output_choices` omit
the audio and the transcript (customer names); the audio is never sent to PostHog.

Message content is allowed in `$ai_*` events (needed for debugging the assistant); mask 9-15
digit sequences (phones, bank numbers) before sending. Free models report zero cost; set PostHog
custom model pricing to 0 for them so cost charts stay correct.

Score and outcome events (backend unless noted):

| Event                          | Source                                                      | Properties                                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assistant_feedback_submitted` | thumbs on a message (`POST .../feedback`)                   | `$ai_trace_id`, `rating` (up, down), masked `comment`                                                                                                                           |
| `survey sent`                  | feedback when survey and rating question ids are configured | `$survey_id`, `$survey_response_<question id>` (1 up, 2 down), optional comment question response, `$ai_trace_id`, `$survey_submission_id` (new UUID), `$survey_completed=true` |
| `assistant_action_decided`     | proposed action decided                                     | `$ai_trace_id`, `kind`, `decision` (confirmed, rejected, expired, failed)                                                                                                       |
| `assistant_quota_hit`          | turn ended by quota                                         | `$ai_trace_id`, `scope` (store, openrouter)                                                                                                                                     |
| `eval_case_scored`             | eval harness ([golden-set.md](golden-set.md))               | `eval_run_id`, `model`, `case_id`, `use_case`, `scorer`, `value`                                                                                                                |
| `eval_run_completed`           | eval harness                                                | `eval_run_id`, `model`, `set` (smoke, full), pass-bar results                                                                                                                   |

## Logs

- Every `tracing` event at `info` and above goes to PostHog logs with `trace_id`, `span_id`,
  severity, `target`, message and the identity attributes; `debug` stays local.
- Required structured fields: `taphoa.error.code` for API errors, `taphoa.job.name` for jobs.
- Request access log: one `info` line per request with route, status and duration.

## Metrics

No OTel metrics pipeline in this program. PostHog LLM analytics computes LLM metrics from `$ai_*`
events; PostHog insights compute product and API metrics from events and logs.

## Product events (PostHog)

Names are `object_verb` in snake case. `distinct_id` is the Clerk user id; every event carries
the `store` group (store UUID) and properties `member_id`, `role`, `environment`, `app_version`.
The backend uses its service version as `app_version`; `language` is app-only. Store-level
events use `store:<store UUID>` with `$process_person_profile=false` and omit `member_id` and
`role`. Outbox captures use UUID v5 (OID namespace, decimal outbox id bytes) as `uuid` for
deduplication across relay retries, and `occurred_at` as the event timestamp. Person properties set by the app on identify: `email`, `name`, `role`.

| Event                                             | Sent by | Properties                                                                           |
| ------------------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `$screen`                                         | app     | `$screen_name` (auto)                                                                |
| `signed_in` / `signed_out`                        | app     | `method` (email_code, google)                                                        |
| `account_switched`                                | app     | `with_pin`                                                                           |
| `store_created`                                   | backend | none                                                                                 |
| `member_joined`                                   | backend | `role`, `can_enroll`                                                                 |
| `product_enrolled`                                | backend | `reference_count`, `source`                                                          |
| `scan_completed`                                  | backend | `purpose`, `match_class`, `latency_ms`                                               |
| `sale_completed`                                  | backend | `total`, `line_count`, `payment_method`, `has_credit`, `manual_lines`, `voice_lines` |
| `sale_voided`                                     | backend | `same_day`                                                                           |
| `receipt_scanned`                                 | backend | `line_count`, `matched_lines`, `latency_ms`                                          |
| `receipt_confirmed`                               | backend | `line_count`, `via` (chat, form)                                                     |
| `stock_adjusted`                                  | backend | `reason`, `via` (manual, assistant)                                                  |
| `expense_added`                                   | backend | `category`, `via`                                                                    |
| `price_changed`                                   | backend | `via` (manual, assistant)                                                            |
| `day_closed`                                      | backend | `difference_bucket` (zero, small, large)                                             |
| `customer_created`                                | backend | none                                                                                 |
| `debt_recorded` / `debt_repaid` / `debt_adjusted` | backend | `amount_bucket`, `method`                                                            |
| `assistant_opened`                                | app     | `entry` (button, chip, receipt, digest, push)                                        |
| `assistant_message_sent`                          | app     | `input` (text, voice), `thread_turn`                                                 |
| `assistant_reply_received`                        | app     | `latency_ms`, `tools_count`, `error_code`                                            |
| `assistant_action_proposed`                       | backend | `kind`, `$ai_trace_id`                                                               |
| `assistant_action_decided`                        | backend | `kind`, `decision`, `$ai_trace_id`                                                   |
| `assistant_feedback_given`                        | app     | `rating`                                                                             |
| `next_step_shown` / `next_step_tapped`            | app     | `kind`, `position`                                                                   |
| `digest_opened`                                   | app     | `entry` (card, push)                                                                 |
| `voice_input_used`                                | app     | `duration_ms`, `language`, `ok`, `engine` (device, server)                           |
| `voice_setup_completed`                           | app     | `platform`, `kind` (bubble, tile, control, action_button, siri)                      |
| `voice_sale_started`                              | app     | `entry`                                                                              |
| `voice_sale_drafted`                              | backend | `lines`, `matched`, `ambiguous`, `unknown`, `latency_ms`, `stt_fallback`             |
| `voice_sale_confirmed`                            | app     | `edited`, `line_count`, `payment_method`, `total`                                    |
| `voice_sale_abandoned`                            | app     | `stage` (listening, draft, pay)                                                      |
| `$exception`                                      | app     | automatic error tracking                                                             |

Backend events are emitted from the outbox relay (one capture per committed business event),
so they are never sent for rolled-back transactions. Amounts in events are buckets except
`sale_completed.total` (integer đồng, needed for revenue insights).

Session replay: on in the app with all text inputs masked, camera preview and product images
masked (`ph-no-capture` equivalents in the React Native SDK), network bodies not recorded.
