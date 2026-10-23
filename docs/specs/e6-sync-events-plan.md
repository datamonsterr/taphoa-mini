# E6 Sync and events: task list and test draft

Status: Draft (conductor working notes). Scope: `/v1/sync/changes`, `/v1/events`, outbox relay, retention.

## Tasks

| #   | Task                                                                                                                                                                                              | Depends | DoD                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| T1  | Cursor codec `base64url(seq)`, reject malformed (400)                                                                                                                                             | E1      | unit tests: roundtrip, garbage, negative, overflow                                                            |
| T2  | `sync` module: `GET /v1/sync/changes` (DISTINCT ON latest per entity, join current rows, delete ops, limit/has_more, 410 below oldest kept seq, role-filtered fields)                             | E1, T1  | integration + contract vs openapi `ChangeFeed`; EXPLAIN uses `change_log_store_seq`                           |
| T3  | Event envelope types + AsyncAPI schema validation test (sample per event type)                                                                                                                    | E1      | `jsonschema` test loads asyncapi.yaml components, validates one sample per message                            |
| T4  | Outbox relay task: LISTEN `outbox` + 1 s poll, `FOR UPDATE SKIP LOCKED` batch 100, `PUBLISH store:{id}:events`, mark published, retry with backoff on Redis error, shutdown via CancellationToken | E1      | integration (PG+Redis): publish, at-least-once on Redis failure, two relays no double-lock, graceful stop     |
| T5  | SSE hub: one PSUBSCRIBE `store:*:events`, per-store broadcast, `GET /v1/events` (frame `id/event/data`, `: ping` every 25 s, Last-Event-ID replay from outbox_events, store isolation, 401)       | E1, T4  | integration SSE client test: receive, resume after drop, isolation, heartbeat (shortened interval via config) |
| T6  | Retention job: compact change_log (>30d keep newest per entity), delete outbox published >7d                                                                                                      | E1      | integration with backdated rows; 410 afterwards                                                               |
| T7  | e2e `packages/e2e/tests/sync.test.ts`: PATCH store/member via E1 -> change feed shows upsert -> SSE receives `store.changed`                                                                      | all     | green in CI                                                                                                   |

## Test cases (draft)

Change feed: empty snapshot (no since) returns all four entity kinds; `since` after last seq returns empty, same cursor, has_more=false;
limit=1 paginates and cursor advances; repeated edits of one entity collapse to latest; deleted entity -> `op=delete` without data;
store isolation (another store's changes never appear); 401 without token; 400 on bad cursor / limit 0 / 1001; 410 when cursor < compacted floor;
role filter (Elder/Helper member rows hide PIN/contact fields, Lead sees them; costs hidden from non-Lead per permission matrix);
ordering strictly by seq.

SSE: 401 no token; bearer and `?access_token=` per contract; event delivered within 1 s of commit; no cross-store leak;
`Last-Event-ID` replays missed events with greater id; heartbeat; client disconnect cleans hub entry; relay restart redelivers unpublished rows.

Relay: idempotent publish, ordering by id, SKIP LOCKED with 2 workers, backoff when Redis down then recovery, shutdown flushes in-flight batch.
