# PostHog dashboards as code

Node 24 ESM, no npm dependencies. These definitions manage the seven X6 product
analytics dashboards (35 insights), three replay playlists, `assistant_enabled`,
three saved log views, store group labels and replay/error project settings.
The X9 `llm/` scope adds four assistant LLM dashboards (21 insights covering
20 spec rows) and three shared saved trace filters.

## Run

Run from the repository root with Node 24 (`.nvmrc`). Credentials are read at
runtime from `~/.config/taphoa-mini/secrets.env`, a `KEY=VALUE` file with mode
`600`. Set `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`; optionally set
`POSTHOG_API_HOST` (default `https://us.posthog.com`). Process environment variables
override the file. Never commit this file or echo its contents. Error messages
redact the personal key and Authorization header.

```sh
node --test infra/posthog/tests
node infra/posthog/apply.mjs --dry-run --offline
pnpm exec prettier --check infra/posthog

# Reads current PostHog objects; no writes.
node infra/posthog/apply.mjs --dry-run
node infra/posthog/apply.mjs --dry-run --only dashboards

# Controller: apply the reviewed plan. This writes to the configured project.
node infra/posthog/apply.mjs
node infra/posthog/apply.mjs --only flags
node infra/posthog/apply.mjs --dry-run --offline --only llm
node infra/posthog/apply.mjs --only llm
# Run again: all 28 LLM objects should report unchanged.
node infra/posthog/apply.mjs --only llm

# Controller: execute queries to check real data for one environment.
node infra/posthog/verify.mjs --environment test --days 7
# Charts that are empty by design (regex on the insight name) report `empty (allowed)`.
node infra/posthog/verify.mjs --environment test --allow-empty 'Backend error logs'
node infra/posthog/verify.mjs --environment production --days 30 --json
node infra/posthog/verify.mjs --only llm --environment test --days 30
node infra/posthog/verify.mjs --only llm --environment eval --days 30
```

`apply --only` accepts `dashboards` (X6 product only), `llm`, `flags`,
`playlists`, `logs`, `groups` or `settings`. With no scope it includes everything.
`verify --only` accepts `dashboards` or `llm`; its default covers both scopes.
`--offline` requires `--dry-run`, skips credentials and network entirely, and uses
empty fixtures. Its full plan includes 77 creates, one skipped group and one settings
update. The isolated LLM plan has 28 creates (4 dashboards, 21 dashboard insights,
3 trace-filter insights). The CLI prints create/update/unchanged/skip totals.
A credentialed dry-run reads lists with pagination and returns the planned
payloads through the exported `apply` function without POST or PATCH requests.

`apply.mjs` matches exact dashboard/insight/playlist/log-view names and feature flag
keys. It updates managed fields in place and preserves IDs. Matching managed
fields report `unchanged`; server-added nested defaults are ignored. Duplicate
exact matches stop the run rather than selecting an arbitrary object. Renaming an
insight creates a new object; this tool does not delete old objects. Dashboard
membership is managed as one dashboard per insight. Applying flags restores the
configured 100% active value, including after an operational kill-switch change.

The `store` group type must be created by an ingested `$groupidentify` before its
labels can be updated. Missing types produce a warning/skip, never a fabricated
group type. The active-store math assumes `store` is group type index `0`.
Project settings enable replay and exception autocapture and disable console log
capture. Input/image/camera masking and network-body restrictions remain the
mobile SDK's responsibility; project settings alone cannot prove replay masking.

`verify.mjs` unwraps and runs every insight's source through `POST query/` with
`refresh: force_blocking`. Each event series or retention entity gets an event property
filter `environment = <name>`. HogQL templates scope events by
`properties.environment` and logs by
`resource_attributes['deployment.environment.name']`; `--days` applies to all
queries. Applied insights cover all environments, without an environment filter.
The table/JSON reports each insight's returned row count, `data` yes/no and `ok`.
Empty product insights fail unless allowed with `--allow-empty`. Empty LLM
insights succeed with `data=no` and `empty (allowed)` because traffic is still
arriving; query errors always fail. A valid zero-cost or zero-error SQL row
counts as data, while a target line does not fabricate rows. Zero-filled native
series do not prove input data. A zero-valued formula also queries its denominator to distinguish a
valid 0% from absent inputs. Rare error/void/voice events and completed funnels
may need deliberate test traffic; week-4 retention needs older cohorts and a
longer window. Local fake-fetch tests are not real-service or deployed proof.

## Chart-to-insight mapping

Each row below is one insight named `<dashboard> · <chart>`. Stable names are the
upsert identity. The two activation insights represent conversion and time.

| Dashboard                | Chart / insight suffix              |
| ------------------------ | ----------------------------------- |
| Product overview         | DAU / WAU / MAU                     |
| Product overview         | Active stores                       |
| Product overview         | New stores per week                 |
| Product overview         | Week-1 and week-4 retention         |
| Product overview         | Stickiness                          |
| Product overview         | Sales per active store per day      |
| Product overview         | Revenue per day                     |
| Product overview         | Payment method mix including credit |
| Activation funnel        | Conversion by sign-in method        |
| Activation funnel        | Time to convert by sign-in method   |
| Checkout and recognition | Scans by match class                |
| Checkout and recognition | Unknown rate                        |
| Checkout and recognition | Scan latency p95                    |
| Checkout and recognition | Sales with manual lines share       |
| Checkout and recognition | Voids per 100 sales                 |
| Receipts and stock       | Scan to confirmation by via         |
| Receipts and stock       | Receipt lines matched share         |
| Receipts and stock       | Stock adjustments by reason and via |
| Assistant adoption       | Opens by entry                      |
| Assistant adoption       | Weekly users sending a message      |
| Assistant adoption       | Messages per user                   |
| Assistant adoption       | Action confirm rate by kind         |
| Assistant adoption       | Feedback ratio                      |
| Assistant adoption       | Next-step CTR by kind and position  |
| Assistant adoption       | Voice input share and success       |
| Assistant adoption       | Digest open rate (card vs push)     |
| Debt book                | Credit sales share                  |
| Debt book                | Debts recorded vs repaid per week   |
| Debt book                | Customers created                   |
| Debt book                | Overdue reminder shares             |
| Reliability              | Exceptions trend                    |
| Reliability              | Crash-free sessions                 |
| Reliability              | Backend error logs per route        |
| Reliability              | API p95 per route                   |
| Reliability              | 5xx rate                            |

Definitions use native trends, retention, stickiness and funnels where possible.
HogQL tables handle multiple dimensions and the ordered activation funnel (third
product enrollment, then sale and day close, within 14 days of sign-in). A product's
`reference_count` counts photos and cannot serve as the enrollment threshold.
The receipts funnel attributes `via` to confirmation, where the property exists.
Backend reliability reads `logs`, scoped to `service.name = taphoa-backend`, with
`http.route`, `duration_ms` and `http.response.status_code` from log attributes.
Only `request completed` access logs enter duration and 5xx calculations.

**Metric limitation:** the telemetry contract contains `digest_opened` but no digest
impression/delivery event. Its chart shows recorded open shares by card/push,
with that limitation in the insight description. A true exposure-to-open rate
requires a future contract extension. Debt amount buckets support counts by
bucket, not precise monetary totals. Overdue reminder share uses next-step
impressions of kind `overdue_debts` divided by all next-step impressions.

## LLM chart-to-insight mapping

The four dashboards requested in #62 follow the assistant section of
[the spec](../../docs/specs/assistant/dashboards.md). The extra Users and stores
dashboard is outside this issue's explicitly requested four-dashboard scope.
Every row below is a stable insight suffix. The next-step spec row has two
insights to show both counts by kind and an ordered conversion funnel.

| Dashboard         | Chart / insight suffix                  |
| ----------------- | --------------------------------------- |
| Assistant health  | Turns per day by environment            |
| Assistant health  | Turn latency p50 / p95                  |
| Assistant health  | Time to first token p50 / p95 by model  |
| Assistant health  | Model calls per turn                    |
| Assistant health  | Error and quota rate                    |
| Assistant health  | Fallback rate by model                  |
| Cost and tokens   | Input / output tokens per day by model  |
| Cost and tokens   | Tokens per turn p50 / p95               |
| Cost and tokens   | Cost per day by model                   |
| Cost and tokens   | Requests vs. 1,000/day free quota       |
| Tools and actions | Tool calls per day by tool              |
| Tools and actions | Tool error and denied rate by tool      |
| Tools and actions | Tool latency p95 by tool                |
| Tools and actions | Use-case mix                            |
| Tools and actions | Proposed action outcomes by kind        |
| Tools and actions | Next-step turns by kind                 |
| Tools and actions | Next-step chip to turn                  |
| Quality           | User feedback (thumbs) over time        |
| Quality           | Eval scores per run by model            |
| Quality           | Eval pass rate by use case              |
| Quality           | Online judge score on production sample |

LLM definitions use SQL `DataVisualizationNode` charts with explicit axes,
series, breakdowns and the 1,000/day goal line. The model-calls histogram groups counts
per trace first and renders discrete bins. Token percentiles sum all attempts
per trace first, including completed turns with zero attempts. The native
next-step funnel uses a 30-minute ordered person window and attributes the
breakdown to the tap's `kind`. There is no shared chip id on the tap event, so
this is aggregate conversion; exact attribution needs a future emitter/contract
extension. The adjacent turn counts use the backend's `next_step_kind`.

The quota chart deliberately spans **all environments**, including during scoped
verification, because it represents a shared provider budget. All other LLM
queries respect `--environment` and `--days`. The target is the spec's budget,
not an automatically discovered provider limit. The error chart uses generation
errors / generation calls and unique quota-hit trace ids / completed trace ids.
Multiple quota scopes cannot double count a turn. Fallback share means calls
with `fallback_index > 0` / calls to that model. Tool errors include denied calls,
as the emitter records them. Costs use the total USD property or the sum of
input/output USD costs; missing prices remain missing. Pricing configuration is
owned by #63.

**Emitter checks and spec clarifications:**

- The backend emits `assistant_feedback_submitted` (`rating=up/down`). This is
  the feedback chart source; the optional `survey sent` mirror and mobile
  `assistant_feedback_given` are excluded to prevent duplicate thumbs. The
  dashboard spec's generic “LLM feedback event” does not name this source.
- Tool span names are `tool:<name>`; metrics filter that prefix rather than
  including arbitrary `$ai_span` events. Latency is in seconds; TTFT uses the
  emitted `time_to_first_token_ms` (the backend also sends the standard seconds
  property `$ai_time_to_first_token`). `use_cases` is an array, exploded for the
  pie, so multi-case turns contribute to each case.
- Eval events come from `packages/eval/src/posthog.ts` with `environment=eval`.
  Run/model/scorer charts and the judge chart can therefore be empty for test
  or production. The online judge row uses the spec's **nightly harness sample
  alternative**, reading existing `eval_case_scored` with `scorer=judge`. It
  creates no evaluator or sampling configuration; #63 owns that setup.
- Eval pass rates follow the harness's per-case rules in
  `packages/eval/src/scorers/aggregate.ts`: judge >=4, facts >=1−1e−9,
  permission leak <0.5, binary scores >=0.5. Latency has a run-level p95 bar,
  so it is excluded from the per-case pass-rate table. Scores are raw units,
  including milliseconds for latency, so compare within a scorer.
- No backend property renames were needed. Historical test traffic observed
  during validation lacks `$ai_trace_id` and `next_step_kind`; current
  `apps/backend/crates/api/src/assistant/telemetry.rs` emits both. Consequently
  grouped trace charts/filters can stay empty until current traffic arrives.

**Shared saved trace filters:** `llm/trace-filters.mjs` manages three favorited
saved insights named `Assistant traces · Errors`, `Assistant traces · Quota hits`
and `Assistant traces · Rejected actions`. They list matching trace ids, first
match timestamps and event counts; open a returned id in LLM analytics to inspect
its trace. They include errors on roots/generations/tools, quota events and
rejected decisions respectively, with date/environment filters at verification.
No prompt or response content is selected.

PostHog's native DataTable “saved filters” are persisted in browser local storage,
with no REST endpoint in the current API. These shared saved trace-table insights
are the durable API-supported equivalent, rather than an invented saved-filter
endpoint. Native browser filter presets themselves are not provisioned. This
limitation is documented in each saved insight description.

API/query shapes were checked against current primary sources before coding:
[API overview](https://posthog.com/docs/api),
[Insights](https://posthog.com/docs/api/insights),
[Query](https://posthog.com/docs/api/query),
[SQL visualizations](https://posthog.com/docs/data-warehouse/query),
[LLM analytics](https://posthog.com/docs/llm-analytics),
[traces](https://posthog.com/docs/ai-observability/traces),
[visualization schema](https://github.com/PostHog/posthog/blob/master/frontend/src/queries/schema/schema-general.ts)
and [saved-filter persistence](https://github.com/PostHog/posthog/blob/master/frontend/src/queries/nodes/DataTable/dataTableSavedFiltersLogic.ts).
The real-service apply and verification results are in
[llm/verification.md](llm/verification.md).

## Add a chart

Edit the dashboard's module in `definitions/` or `llm/` and add a stable suffix, query and
useful description. Native event nodes must use contract event/property names.
For HogQL include `{{environment}}` as a WHERE predicate and `{{days}}` as the
lookback number, and list referenced event names in the chart's fourth tuple
field. Applying renders the environment predicate as `1 = 1`; verifying supplies
the environment predicate and day window. Never interpolate raw CLI input into
SQL. Update the coverage count in `tests/definitions.test.mjs` or `tests/llm.test.mjs` and the mapping table,
then run the tests and offline plan before controller verification.

The tests inject fake fetch at the HTTP boundary. CI runs only tests and the
offline plan, with no PostHog credentials or requests. `tests/package.json` and
`tests/index.mjs` let Node 24 resolve the explicitly requested test directory.

## Masked replay smoke

The Expo web app uses `posthog-js`; native `posthog-react-native` replay does not support
web or Expo Go. Android APKs need the linked plugin and public PostHog key at bundle time.
CI uses the existing `POSTHOG_PROJECT_TOKEN` secret and `POSTHOG_HOST` variable for both
web exports and `assembleRelease`, with `EXPO_PUBLIC_ENVIRONMENT=test`. Setting these only
when launching a prebuilt APK/export cannot enable analytics retroactively. Missing keys
leave the app's analytics disabled. EAS builds obtain their public key from EAS environment
variables independently; the `test`/`e2e` profiles supply the test label.

For a cheap replay proof without an emulator, load the configured credentials in a shell
without shell tracing, leave `E2E_WEB_EXPORT_READY` unset so the export embeds the values,
and run:

```sh
set -a
. ~/.config/taphoa-mini/secrets.env
set +a
EXPO_PUBLIC_POSTHOG_KEY="$POSTHOG_PROJECT_TOKEN" \
EXPO_PUBLIC_POSTHOG_HOST="${POSTHOG_INGEST_HOST:-https://us.i.posthog.com}" \
EXPO_PUBLIC_ENVIRONMENT=test \
EXPO_PUBLIC_API_URL=https://backend-test-70c2.up.railway.app \
POSTHOG_REPLAY_SMOKE=1 \
pnpm --filter @taphoa/mobile test:e2e:web replay.spec.ts --project chromium --workers 1
```

This signs nobody in, submits no form, and never opens the assistant. It interacts with
the sign-in input for more than 10 seconds, verifies successful snapshot ingestion, masked
input values, blocked media canaries, and an `environment=test` product event with the
same session id. Browser automation is captured deliberately only in test. It emits a safe
`masked-replay-evidence` attachment containing the session id and assertion results.

List `GET /api/projects/<id>/session_recordings/` with the personal key in the Authorization
header to verify that id after ingestion. For environment scoping, pass event properties
`[{"key":"environment","value":["test"],"operator":"exact","type":"event"}]` in the
URL-encoded `properties` parameter. A read-only HogQL query of the matching `$session_id`
can independently confirm its `environment=test` `$screen` event. Browser `$snapshot`
envelopes deliberately omit super properties, so environment comes from the correlated
product event, not the snapshot envelope. Project settings alone never prove masking.
