# X0 plan: assistant contract and shared interfaces

Status: In progress · Date: 2026-10-25 · Epic brief: [epics.md](epics.md) "X0" · Contract source:
[assistant.md](assistant.md) "API contract", [telemetry-contract.md](telemetry-contract.md)
"Product events".

## Contract decisions

These settle shapes the spec leaves open. Wave 2 (X3, X4, X7) codes against them; changes go
through the program controller.

- **Tags:** `Assistant` (threads, messages, actions, feedback, next steps, digest) and `Devices`.
  Every operation uses the default `bearerAuth`.
- **Paths:** exactly the table in assistant.md. Path parameters are `threadId`, `actionId`,
  `messageId`, `token` (an Expo push token, URL-encoded).
- **Lists:** `GET /v1/assistant/threads` uses the existing cursor convention (`cursor`, `limit`,
  `{items, next_cursor}`), newest first. `GET /v1/assistant/next-steps` returns
  `{items: NextStep[]}` with at most 8 items.
- **Message stream:** `POST /v1/assistant/threads/{threadId}/messages` answers `200` with
  `text/event-stream`. Each SSE frame has `event: <name>` and one JSON `data:` line. The OpenAPI
  schema `AssistantStreamEvent` is a `oneOf` of `{event: const, data: $ref}` objects, one per SSE
  event in assistant.md. Payload schemas: `AssistantMessageCreated`, `AssistantMessageDelta`,
  `AssistantToolStarted`, `AssistantToolFinished`, `AssistantAction`, `AssistantCard`,
  `AssistantMessageCompleted`, `AssistantStreamError`. Quota and model failures arrive as an
  `error` event inside a `200` stream; validation, not-found and permission failures are normal
  JSON errors before the stream starts.
- **Stream end:** `message.completed` and `error` are terminal. The stream is not resumable (no
  `Last-Event-ID`); clients never re-send the POST on their own.
- **Cards:** `AssistantCard` is a `oneOf` on `type`: `receipt_lines`, `restock_list`,
  `debt_list`, `chart_bars`.
- **Actions:** `AssistantAction.kind` is the `propose_*` tool name without the prefix
  (`stock_adjustment`, `expense`, `price_change`, `threshold_update`, `reorder_list`,
  `receipt_line_update`, `receipt_confirm`, `repayment`, `debt_adjustment`, `invite`).
  `payload` is an object whose shape depends on `kind`. Status values follow the lifecycle in
  assistant.md (`proposed`, `executing`, `done`, `failed`, `rejected`, `expired`). Confirm and
  reject return the updated `AssistantAction`; a stale or already decided action is `409` with
  code `action_stale` or `already_decided`.
- **Language:** `AssistantLanguage` is `vi` or `en`.
- **AsyncAPI:** `assistant.action.confirmed` and `assistant.action.rejected` are store events on
  the existing store event channel (same envelope), so `StoreEvent.type` in OpenAPI gains both
  values. The SSE message stream stays in OpenAPI only.
- **Devices:** `POST /v1/devices` upserts by token and returns `Device`; `DELETE` is idempotent
  (`204`).

## Shared interfaces

- `packages/api-client`: `parseSseStream` (bytes to `{event, data, id?}` frames) and
  `readAssistantStream` (frames to typed `AssistantStreamEvent`, stops after a terminal event,
  never reconnects, throws a typed error when the stream ends early), plus a
  `sendAssistantMessage` client method.
- `apps/mobile/src/test/mock`: handlers for every assistant and devices path; the message route
  streams a canned Vietnamese reply as SSE; tests can script the next reply.
- `apps/mobile/src/lib/analytics.ts`: `capture(event, props)` typed over the app-sent product
  events; a swappable sink, no-op by default (X6 plugs in PostHog).
- `apps/backend/crates/api/src/analytics.rs`: `ProductEvent` enum of backend-sent product events,
  `CaptureEvent` and `Analytics::capture_event` for any event including `$ai_*` LLM analytics
  events, `Analytics` trait, `NoopAnalytics`, `AppState.analytics` (X6 plugs in PostHog).
- `MIGRATOR` ignores versions applied in the database but missing from the source tree, so a
  branch deploy to the shared `test` database does not break the next `main` deploy.

## Tasks (tests first in each)

| #   | Task                                                                  | Tests written first                                              | Worker      |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------- |
| T1  | OpenAPI + AsyncAPI sections, regenerate `schema.d.ts`                 | `tests/contract.rs` samples, `tests/asyncapi.rs` samples         | contract    |
| T2  | `analytics.rs`, `AppState.analytics`, migrator tolerance              | `analytics.rs` unit tests, `tests/migrations.rs` missing version | backend     |
| T3  | `lib/analytics.ts`                                                    | `lib/analytics.test.ts`                                          | mobile      |
| T4  | SSE helper + client method; mock handlers (after T1)                  | `src/sse.test.ts`; `test/mock/assistant.test.ts`                 | client-mock |
| T5  | Review, `pnpm turbo run typecheck test`, `ci-ok`, merge, deploy watch | none                                                             | controller  |

T1, T2 and T3 run in parallel. T4 starts after T1 merges into the epic branch.

## Acceptance

- `cargo test -p taphoa-api --test contract --test asyncapi` green with the new paths.
- api-client vitest covers the SSE parser: deltas, tool events, error, stop without reconnect.
- Mobile Jest test streams one canned reply through the mock.
- `pnpm turbo run typecheck test`, `pnpm lint:api`, `pnpm lint:api:async`, `ci-ok` green.

## Version pins

Recorded by workers after checking current docs: sqlx 0.9.0 (migrator), openapi-fetch 0.17
(`parseAs: "stream"`), openapi-typescript 7.13.
