# X3 plan: assistant backend

Status: In progress · Date: 2026-10-25 · Epic brief: [epics.md](epics.md) "X3" · Spec:
[assistant.md](assistant.md), ADR [0005](../../adr/0005-assistant-in-backend.md), ADR
[0007](../../adr/0007-posthog-only-observability.md), [telemetry-contract.md](telemetry-contract.md)
"Assistant spans" and "Assistant LLM analytics events".

Branch `epic/x3-assistant-backend`. Migrations `08xx`. Debt tools, the `overdue_debts` and
`digest` next-step rules, the digest job and push are out of scope (X5, X8).

## Decisions

These settle what the spec leaves open. Vendor facts were checked on 2026-10-25.

- **Model calls (OpenRouter chat completions).** `POST https://openrouter.ai/api/v1/chat/completions`
  with `model`, `messages`, `tools` (`{type: function, function: {name, description, parameters}}`),
  `tool_choice: auto`, `stream: true`, `max_tokens`, and `reasoning: {effort}` from
  `ASSISTANT_REASONING_EFFORT` (default `low`). Stream parsing: skip SSE comment lines
  (`: OPENROUTER PROCESSING`), stop at `data: [DONE]`, assemble `delta.tool_calls` fragments by
  `index`, read `usage` from the extra chunk before `[DONE]` (its `finish_reason` repeats the
  terminal one and is accounting only). Errors before commit are JSON with an HTTP status (400,
  401, 402, 429, 502, 503); errors after commit are a `data:` chunk with a top-level `error` and
  `finish_reason: "error"`, and a 200 stream with only an error chunk is a failure.
- **Fallback is client side.** The loop walks `ASSISTANT_MODELS` in order, one model per HTTP
  request, and moves to the next model on 429 (not the daily free quota), 5xx, timeout, a
  mid-stream error before any text delta was sent, or tool-call arguments that are not valid
  JSON. OpenRouter's `models` array is not used: its docs do not cover streaming or invalid tool
  JSON, and per-attempt calls give an exact `fallback_index` and one span and `$ai_generation`
  per attempt. A failure after text deltas reached the client ends the turn with
  `error: model_unavailable`. The free daily quota (429 whose error names the free-model daily
  limit) stops the turn with `error: quota`, sets a Redis flag until the next UTC midnight, and
  later turns make no model call while it is set.
- **Free models.** The default `ASSISTANT_MODELS` is
  `thinkingmachines/inkling-small:free,nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-31b-it:free`
  (free, `tools` supported, best agentic index on 2026-10-25). Only `:free` ids are allowed, so a
  fallback never bills. X7's comparison picks the final order.
- **Agent loop.** At most 6 model calls per user message; tool calls of one model turn run in
  parallel with a 5 s timeout each; the last 20 thread messages plus tool results form the context
  and the oldest tool results are dropped first. Tool output goes into `tool` messages as JSON
  data only. Confirmed or rejected actions since the last turn are added as one short system note.
- **Stream.** Axum `Sse` over a channel. The turn runs in a spawned task, so a client disconnect
  never loses the persisted reply. Frames follow the X0 contract (`AssistantStreamEvent`).
  Validation, ownership and not-found errors are JSON before the stream starts.
- **Quota.** `ASSISTANT_DAILY_MESSAGES_PER_STORE` (default 60) counts user messages in Redis key
  `assistant:quota:{store}:{business_date}` (TTL 48 h; in-memory counter without Redis). Requests
  with honoured eval headers skip the store cap (the eval store runs about 140 cases a day) but
  still respect the OpenRouter flag. A quota stop sends `error: quota` with a Vietnamese message.
- **Eval headers.** With `ASSISTANT_ALLOW_EVAL_HEADERS=1` only, `X-Taphoa-Eval-Run: <run id>` and
  `X-Taphoa-Today: YYYY-MM-DD` set the turn's `today` (prompt and every tool) and tag `$ai_*`
  events `environment=eval`, `eval_run_id=<run id>`. Otherwise both headers are ignored. Tools take
  `today` from the tool context and never call `now()` for business dates.
- **Confirm runs the normal handler.** `POST /v1/assistant/actions/{id}/confirm` replays the write
  through the in-process router (`crate::router(state)` + `tower::ServiceExt::oneshot`) with the
  caller's own auth headers, so the existing handler, its `auth::can` check, validation and
  idempotency run unchanged and X1's `Actor` change needs no assistant change. Downstream
  idempotency keys and client ids are derived from the action id (UUID v5), so a crash between
  `executing` and `done` is safe to replay. Kinds without an endpoint (`receipt_line_update`,
  `reorder_list`) run assistant-owned code in one transaction.
- **Action states.** `proposed → executing → done | failed`, `proposed → rejected`,
  `proposed → expired` (24 h, or the target changed: product price or threshold differs from the
  snapshot in the payload, receipt no longer draft or line changed, product archived). Confirm
  needs `Idempotency-Key`; the same key replays the stored action; another key on a decided action
  is 409 `already_decided`; stale is 409 `action_stale`. Only the thread owner sees, confirms or
  rejects an action; the handler re-checks the confirming member's permission (403 when the role
  changed).
- **Telemetry.** Spans use `tracing` with OpenTelemetry field names (`otel.name`, `otel.kind`,
  `gen_ai.*`, `taphoa.*`); X2's `tracing-opentelemetry` bridge exports them. Span tests use X2's
  in-memory exporter once X2 is on `main`. `$ai_trace_id` is the current OTel trace id (32 hex);
  without an active OTel context, a random 32-hex id. `distinct_id` is the member id until X1
  merges, then the Clerk user id. Events go through `AppState.analytics` in a spawned task, never
  blocking the reply; 9-15 digit sequences are masked in `$ai_*` content.
- **Feedback.** PostHog's current LLM feedback is the Surveys integration: a `survey sent` event
  with `$survey_id`, `$survey_response_<question id>` (1 up, 2 down), `$ai_trace_id`,
  `$survey_submission_id` and `$survey_completed: true`. The backend sends it when
  `ASSISTANT_FEEDBACK_SURVEY_ID` and `ASSISTANT_FEEDBACK_QUESTION_ID` (and optional
  `ASSISTANT_FEEDBACK_COMMENT_QUESTION_ID`) are set, and always sends `assistant_feedback_submitted`
  (`$ai_trace_id`, `rating`, `comment`). The survey is created in PostHog with the API. The
  telemetry contract is updated in this PR.
- **Next steps.** SQL rules in `assistant/next_steps/` as a list of rule functions, so X5
  (`overdue_debts`) and X8 (`digest`) add a file each. `receipt_detected` and `unknown_product`
  come from the query flags. At most 8 chips, permission-filtered, ranked by priority.

## Module layout (`apps/backend/crates/api/src/assistant/`)

```
mod.rs            router, AssistantState (config + model client) in AppState.assistant
config.rs         ASSISTANT_* variables
model/            ChatModel trait, types, openrouter.rs (streaming client), scripted.rs (mock)
agent.rs          loop: quota, context, model calls with fallback, parallel tools, persistence
stream.rs         SSE frames (contract types)
threads.rs        threads, messages, feedback handlers
tools/            Tool trait, registry + permission filter; sales.rs, stock.rs, ops.rs,
                  catalog.rs, help.rs, tax.rs, propose.rs (one file per batch)
actions.rs        lifecycle, confirm via internal dispatch, reject, expiry
next_steps/       rule list, one file per rule group
quota.rs, eval.rs, telemetry.rs (spans and $ai_* builders, digit masking)
prompts/system.vi.md, prompts/system.en.md
help/*.md         Vietnamese help articles
rules/tax_vn.toml tax rule table with sources and effective date
```

Integration tests: `apps/backend/crates/api/tests/assistant_*.rs` (real Postgres and Redis from
the local compose stack, `DATABASE_URL`/`REDIS_URL`), contract checks through
`tests/common/Contract`. Unit tests inline. Every test uses the scripted model; none calls
OpenRouter except `packages/e2e/tests/assistant.test.ts` (at most 30 requests per run).

## Task graph

Workers: superorchestrator first; codex (complex level) is in cooldown until about 13:50 UTC on
2026-10-25, so complex tasks fall back to native subagents (`claude-sonnet-5-5`, medium effort).
Each worker uses its own `CARGO_TARGET_DIR=/media/storage/cache/x3-<task>` (sccache stays on) to
avoid the shared target lock, and deletes it when done. TDD in every task: failing tests first.

| Task | Content                                                                                                                                                                                                                                                                            | Tests first                                                                 | Depends               | Route              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------- | ------------------ |
| T1   | Migration `0801_assistant.sql`; config; `AppState.assistant`; router merge; threads CRUD and list; feedback storage; `ChatModel` trait + scripted model; `Tool` trait, registry, permission filter; quota; eval headers; stub tool files                                           | `tests/assistant_threads.rs`, unit tests for config, quota, eval, registry  | none                  | native sonnet      |
| T2   | Agent loop and SSE stream; fallback; parallel tools with timeout; max 6 calls; context window; action notes; injection as data; Vietnamese and English system prompts                                                                                                              | `tests/assistant_loop.rs`                                                   | T1                    | native sonnet      |
| T3   | OpenRouter streaming client (`ChatModel`), error mapping, daily-quota detection, against a local mock HTTP server                                                                                                                                                                  | unit tests in `model/openrouter.rs`                                         | T1                    | native sonnet      |
| T4   | Read tools: overview, sales summary, top products, search sales, search products, stock levels, restock plan (+ `restock_list` card), margin, dead stock, forecast (holiday uplift table), supplier prices, list expenses                                                          | `tests/assistant_tools_sales.rs`                                            | T1                    | native sonnet      |
| T5   | Read tools: day-close explain, review queue, manual-line matches, recognition health, member activity, anomalies, catalog issues, threshold suggestions, setup checklist, get receipt (+ `receipt_lines` card), start export, search help + articles, tax overview + `tax_vn.toml` | `tests/assistant_tools_ops.rs`                                              | T1                    | native sonnet      |
| T6   | Propose tools (stock adjustment, expense, price change, threshold, reorder list, receipt line update, receipt confirm, invite); action lifecycle; confirm through the router; reject; expiry and stale; outbox events; product events                                              | `tests/assistant_actions.rs`                                                | T1                    | native sonnet      |
| T7   | Next-steps rules and endpoint; p95 < 50 ms on the seed                                                                                                                                                                                                                             | `tests/assistant_next_steps.rs`                                             | T1                    | superorchestrator  |
| T8   | GenAI spans; `$ai_trace`/`$ai_generation`/`$ai_span`, feedback, `assistant_action_decided`, `assistant_quota_hit` events; masking; telemetry contract doc update                                                                                                                   | `tests/assistant_telemetry.rs` (X2 in-memory exporter, recording analytics) | T2, T3, T6, X2 merged | native sonnet      |
| T9   | Railway `ASSISTANT_*` in `.railway/railway.ts`, `.env.example`; e2e `assistant.test.ts`; PostHog feedback survey; variables on `test` and `production`                                                                                                                             | e2e spec                                                                    | T2-T8                 | controller + haiku |

Waves: T1 alone; then T2, T3, T6 (three parallel builds); then T4, T5, T7; then T8 after X2 merges;
then T9, the branch deploy, review and merge. Rebase on `main` after each wave (X1 changes the
`Actor`, X2 adds telemetry).

## Acceptance (epic)

- `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo nextest run`
  green; `ci-ok` green on the PR.
- Loop tests: parallel tool calls, max steps, fallback on 429/timeout/bad JSON, quota,
  permission-filtered tool list, injection text only as data. Action tests: confirm executes once,
  replay, stale 409, seller denied. Span tests with the in-memory exporter. Next steps p95 < 50 ms.
- e2e `assistant.test.ts` green on Railway `test` via `gh workflow run deploy.yml -f ref=epic/x3-assistant-backend`.
- X7 smoke golden set passes once its harness exists; X7 findings fixed.

## Cross-epic notes

- X1: after merge, `EventContext.distinct_id` and `$ai_*` `distinct_id` switch to the Clerk user id.
- X2: span tests and `$ai_trace_id` from the OTel context need X2's `telemetry` module on `main`.
- X5: adds `tools/debts.rs` (registered in `tools::all()`) and `next_steps/overdue_debts.rs`.
- X6: confirmed actions run the normal handlers, which report `via: manual`; X6 can read the
  internal `X-Taphoa-Via: assistant` header that confirm adds to the replayed request.
- X7: eval headers skip the per-store cap; the OpenRouter daily flag still applies.
- X8: adds `next_steps/digest.rs` and reuses U1, U2 tools.
