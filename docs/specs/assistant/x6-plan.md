# X6 plan: product analytics (PostHog)

Status: In progress · Date: 2026-10-26 · Epic brief: [epics.md](epics.md) "X6" · Spec:
[telemetry-contract.md](telemetry-contract.md) "Product events", PostHog section of
[dashboards.md](dashboards.md), ADR [0007](../../adr/0007-posthog-only-observability.md).

Branch `epic/x6-product-analytics` from `main` (X0, X2, X3, X5 merged). X1 (Clerk) merges before
X6; the Clerk-dependent wiring (identify, sign-in events, Clerk user id as `distinct_id`) lands
after the rebase onto `main` with X1.

## Version pins and docs checked (2026-10-26)

| Component                      | Pin                                                                                               | Notes                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `posthog-react-native`         | 4.83.0                                                                                            | `PostHogProvider` (`apiKey`, `options`, `autocapture`), `usePostHog`, `useFeatureFlag`, `PostHogMaskView`, `posthog.screen`, `identify`, `group`, `register`, `reset`, `getSessionId`, `captureException`.                                                                           |
| `@posthog/react-native-plugin` | 2.12.6                                                                                            | Native session replay (renamed from `posthog-react-native-session-replay` in SDK 4.47). Android API 26+, iOS 13+. Not in Expo Go; the app already uses a development build.                                                                                                          |
| Expo peers                     | `expo-application`, `expo-device`, `expo-localization`, `expo-file-system` via `npx expo install` | Device, app version and locale properties; file persistence.                                                                                                                                                                                                                         |
| PostHog capture API            | `POST https://us.i.posthog.com/batch/`                                                            | Body `{api_key, batch:[{event, distinct_id, properties, timestamp, uuid}]}`; groups through `properties.$groups`; `$groupidentify` creates group types; `$process_person_profile=false` for store-level events.                                                                      |
| PostHog REST API               | `https://us.posthog.com/api/projects/682994/...`                                                  | `dashboards/`, `insights/` (`query` with `InsightVizNode`), `feature_flags/`, `session_recording_playlists/` (`type: filters`), `logs/views/`, `groups_types/update_metadata/`, `query/` (sync, `refresh: blocking`). Project settings through `organizations/{org}/projects/{id}/`. |

Docs read: PostHog React Native SDK, session replay (React Native), error tracking (React
Native), capture API, the PostHog OpenAPI schema (`/api/schema/`) and the frontend query schema
for `TrendsQuery`, `FunnelsQuery`, `RetentionQuery`, `StickinessQuery`, `LifecycleQuery`,
`HogQLQuery` and `RecordingUniversalFilters`.

## Decisions

- **One typed sink in the app.** `apps/mobile/src/lib/analytics.ts` stays the only capture API
  (X0). X6 adds `PostHogSink`, registered by `AnalyticsProvider` in the root layout. The sink
  adds nothing to event props; common properties (`environment`, `app_version`, `language`) are
  PostHog super properties (`register`), `member_id`, `role` and the `store` group are set by the
  identity hook after sign-in. Without `EXPO_PUBLIC_POSTHOG_KEY` the provider renders children
  and the no-op sink stays, so tests and local runs never need PostHog.
- **Screens.** Autocapture of screens is off (expo-router has no navigation container to hook);
  `useScreenTracking` calls `posthog.screen(pathname)` on every pathname change, with dynamic
  segments replaced by their names (`/product/[id]`), so `$screen_name` has low cardinality.
- **Replay and errors.** `enableSessionReplay: true` with `maskAllTextInputs`, `maskAllImages`,
  `maskAllSandboxedViews` on, `captureLog` and `captureNetworkTelemetry` off; the camera preview
  and product images are wrapped in `PostHogMaskView`. Error tracking autocapture: uncaught
  exceptions and unhandled rejections, no console capture.
- **Feature flag.** `assistant_enabled` (boolean, 100 %, kill switch). `useAssistantEnabled()`
  returns `true` while flags load or PostHog is off (fail open: the flag only turns the assistant
  off when PostHog says so).
- **Headers.** `packages/api-client` sends `X-POSTHOG-SESSION-ID` from `getSessionId` and a W3C
  `traceparent` (random trace id, random span id, flags `01`) on every request, so a backend span
  is linked to the replay session and a trace id is known client side.
- **Backend sink.** `PostHogAnalytics` (reqwest) batches captures in a background task (flush on
  100 events or 2 s, retry with backoff, flush on shutdown) and posts to `/batch/`. It adds
  `environment` (from `TelemetryConfig`) and `app_version` (service version). `language` is an
  app-only property. Enabled by `POSTHOG_PROJECT_TOKEN` (+ optional `POSTHOG_HOST`), otherwise
  `NoopAnalytics`.
- **Outbox mapping.** The relay maps each published outbox row to at most one product event
  (`events::product_events::map`) and captures it after the batch commits, with a deterministic
  event `uuid` (UUID v5 of the outbox id) so at-least-once relays never double count. Actor
  resolution: envelope `actor.member_id`, else `data.member_id`, else a store-level
  `distinct_id` (`store:<uuid>`, `$process_person_profile=false`). Member role and (after X1)
  Clerk user id come from one `members` lookup per batch. Mapping:

  | Outbox event                                 | Product event                                                                    |
  | -------------------------------------------- | -------------------------------------------------------------------------------- |
  | `store.created` (new)                        | `store_created`                                                                  |
  | `member.changed` with `change=joined`        | `member_joined` (`role`, `can_enroll` from `members`)                            |
  | `product.enrolled` (new)                     | `product_enrolled` (`reference_count`, `source`)                                 |
  | `scan.completed` (now emitted)               | `scan_completed` (`purpose`, `match_class`, `latency_ms`)                        |
  | `sale.created` (+`manual_lines`)             | `sale_completed` (`has_credit` = `credit_amount > 0` or `payment_method=credit`) |
  | `sale.voided` (+`same_day`)                  | `sale_voided`                                                                    |
  | `receipt.scanned` (new)                      | `receipt_scanned` (`line_count`, `matched_lines`, `latency_ms`)                  |
  | `receipt.confirmed` (+`via`)                 | `receipt_confirmed` (`via`: `chat` when the assistant confirmed, else `form`)    |
  | `stock.changed` reason `adjustment` (+`via`) | `stock_adjusted`                                                                 |
  | `expense.created` (+`via`)                   | `expense_added`                                                                  |
  | `price.changed` (+`via`)                     | `price_changed`                                                                  |
  | `day.closed`                                 | `day_closed` (`difference_bucket`)                                               |
  | `customer.created`                           | `customer_created`                                                               |
  | `debt.recorded` kind `credit_sale`           | `debt_recorded` (`amount_bucket`, `method=credit_sale`); kind `void` is skipped  |
  | `debt.repaid` / `debt.adjusted`              | `debt_repaid` / `debt_adjusted`                                                  |
  | `assistant.action.*`                         | none (X3 captures `assistant_action_*` with `$ai_trace_id`)                      |

  `via` comes from the `x-taphoa-via: assistant` header that X3's action executor sets on router
  calls; handlers record it in the outbox payload (`manual` otherwise). New and extended
  messages are documented in `docs/api/asyncapi.yaml`.

- **Dashboards as code.** `infra/posthog/` is Node 24 ESM with no dependencies: `apply.mjs`
  (idempotent: find by name, update in place, create when missing), `verify.mjs` (runs each
  insight's query through `/query/` for one environment and fails when a dashboard has no data),
  definitions per dashboard, `--dry-run` printing the plan without writes. The personal API key
  and project id are read from `~/.config/taphoa-mini/secrets.env` at run time (environment
  variables override) and never printed. Group type metadata is applied only once the `store`
  group type exists (created by the first `$groupidentify`).

## Task graph

| ID  | Task                                                                                                                                                                      | Owner            | Tests first                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| T1  | Backend: `PostHogAnalytics`, config, relay mapping, `via` extractor, new/extended outbox payloads, AsyncAPI, contract doc                                                 | delegated (Rust) | `analytics.rs` unit tests, `events/product_events.rs` tests, `tests/analytics_relay.rs` |
| T2  | Mobile: `posthog-react-native`, provider, sink, super properties, screen tracking, replay masking, error tracking, flag hook, identity hook; api-client headers           | delegated (TS)   | Jest contract-event table test, provider/hook tests, vitest header tests                |
| T3  | `infra/posthog/**`: definitions for the seven dashboards, apply, verify, dry-run tests, CI job                                                                            | delegated (Node) | `node --test infra/posthog/tests`                                                       |
| T4  | Rebase onto `main` with X1: Clerk user id as `distinct_id`, identify + `store` group in `AuthGate`, `signed_in`/`signed_out`/`account_switched`, `assistant_enabled` gate | controller       | existing Jest suites                                                                    |
| T5  | Railway/EAS variables, `apply.mjs` against project 682994, branch deploy to `test`, `verify.mjs --environment test`, evidence on the PR                                   | controller       | API query per insight                                                                   |
| T6  | Review, `ci-ok`, squash merge, worktree cleanup                                                                                                                           | controller       | `gh pr view`                                                                            |

## Evidence

Filled in as tasks land.
