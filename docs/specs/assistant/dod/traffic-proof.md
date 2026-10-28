# Traffic proof — issue #66

Status: **incomplete DoD**. The Phase A sections below are historical. The later
[Production smoke](#production-smoke) section records the owner-authorized production
flow and current evidence. A populated chart is not proof of mature retention or
production judge sampling. All timestamps are UTC; screenshots come from the
PostHog exports API. No PostHog UI login was attempted.

## Scope and execution

Rebased onto `origin/main` (`7007ddb`) before reading the dashboard, telemetry,
PostHog, pricing/judge, and deployment guides. Used Node 24.21.0 and pnpm 11.5.0.
Railway readback identified active test deployment
`64bb2c62-1031-4395-87fd-ff3397b21bd0` (CLI upload metadata had no commit hash),
and production deployment `94be8e94-b898-4d49-a841-804e703edc57` at
`301dacfd8414ff824cfde46e7252a99903455cfe`. The local rebase does not prove those
services run the local revision.

No backend/mobile source changes, deploy, push, PostHog deletion, or production
business write was performed. The controller explicitly relaxed the original
existing-Clerk-users restriction for the **unmodified web fixtures**: their normal
`+clerk_test` development-user creation and cleanup were permitted. The separate
browser dwell used an existing eval test user.

The initial Playwright selection included the `perf` project's dependency, which
expanded Chromium selection to assistant files. `assistant.spec.ts` sends a
`probeModel()` greeting **before** deciding to skip a non-scripted backend. One
unintended greeting POST occurred; the run was stopped when this was detected.
The event inventory increased from 40 to 41 test `$ai_trace` and 102 to 103
`$ai_generation` events during that interval. This is an execution incident,
not completion of the requested Phase B traffic. The corrected run selected only
Chromium non-assistant files; performance runs must use `--no-deps`. No eval smoke
or judge run/apply command was sent in Phase A. Judge verification only reads.
At 17:31:47Z, a logs query found **0** `request completed` entries for test POST
routes matching `%assistant%messages%` since the corrected restart at 17:21:05Z.

### How suites target an environment

- `.github/workflows/railway-integration.yml` runs Rust tests **in process** with
  throwaway databases on Railway services. It does not target the deployed HTTP
  server or mobile app, and is not proof of client analytics/replay.
- `.github/workflows/deploy.yml` dispatch deploys and seeds `test`, then runs
  `scripts/ci/run-e2e.sh` against `BACKEND_URL`. It includes assistant checks and
  user lifecycle steps, so it was not dispatched for this constrained run.
- `apps/mobile/playwright.config.ts` exports web with `EXPO_PUBLIC_API_URL`,
  embeds the Clerk publishable key, and serves `dist-web` locally. Its global
  setup checks `/readyz`; fixtures call that same deployed API. PostHog needs
  `EXPO_PUBLIC_POSTHOG_KEY`, host, and `EXPO_PUBLIC_ENVIRONMENT=test` at export.
- `scripts/e2e/stack.sh` starts a local backend stack; it was not started here.
  `.github/workflows/android-e2e.yml` builds an APK against a local stack at
  `10.0.2.2`; it has no deployed-environment dispatch input. This host has no
  `maestro`, `adb`, or emulator executable. No Maestro/native replay run is claimed.
- Production smoke is exactly `scripts/ci/wait-healthy.sh` from the deploy job:
  GET `/healthz` and GET `/readyz`. GitHub repository `BACKEND_URL` was absent;
  Railway status supplied `https://backend-production-5f5c.up.railway.app`.

Production smoke was repeated with explicit timestamps at
**2026-10-28T17:40:11Z–17:40:12Z**: `/healthz` **200** and `/readyz` **200** on
attempt 1, exit **0**. These were the only production HTTP endpoints called.

### Commands

Credentials were loaded from the private mode-600 secrets file without logging
values. Keep all variables out of shell tracing. Run from the repository root:

```bash
git fetch origin && git rebase origin/main
pnpm install --frozen-lockfile
apps/mobile/e2e-web/fixtures/make-video.sh

set -a
source ~/.config/taphoa-mini/secrets.env
set +a
export EXPO_PUBLIC_API_URL=https://backend-test-70c2.up.railway.app
export EXPO_PUBLIC_ENVIRONMENT=test
export EXPO_PUBLIC_POSTHOG_KEY="$POSTHOG_PROJECT_TOKEN"
export EXPO_PUBLIC_POSTHOG_HOST="$POSTHOG_INGEST_HOST"
export CI=1
# First run exports web automatically. Add E2E_WEB_EXPORT_READY=1 only to reuse
# this same environment's completed export; never reuse an unrelated export.
pnpm --filter @taphoa/mobile exec playwright test \
  'e2e-web/(account|camera|checkout|close|debts|expense|inventory|onboarding|quick-enroll|receipts|recognition|reports|screens)\.spec\.ts' \
  --project=chromium --workers=2 --list
pnpm --filter @taphoa/mobile exec playwright test \
  'e2e-web/(account|camera|checkout|close|debts|expense|inventory|onboarding|quick-enroll|receipts|recognition|reports|screens)\.spec\.ts' \
  --project=chromium --workers=2
# Separate project avoids pulling assistant specs in through dependencies:
env -u CI E2E_WEB_EXPORT_READY=1 pnpm --filter @taphoa/mobile exec playwright test \
  e2e-web/perf.spec.ts --project=perf --no-deps --workers=1

RAILWAY_TOKEN="$RAILWAY_TOKEN_PRODUCTION" railway status --json
scripts/ci/wait-healthy.sh https://backend-production-5f5c.up.railway.app

node infra/posthog/verify.mjs --environment test --days 7 --json
node infra/posthog/verify.mjs --environment production --days 30 --json
node infra/posthog/verify-nonsynthetic.mjs --environment test --days 7
node infra/posthog/verify-nonsynthetic.mjs --environment production --days 30
node infra/posthog/llm/evaluations-verify.mjs
node --test infra/posthog/tests
pnpm --filter @taphoa/mobile lint
pnpm --filter @taphoa/mobile typecheck
```

The additional browser dwell signed in through Clerk using an existing eval
lead, opened `/inventory`, `/account`, `/reports`, spent 12 seconds on each, then
waited 35 seconds for the SDK batch flush. Between **2026-10-28T17:22:09Z** and
**17:23:26Z**, it observed two real `/batch/` requests and no page errors. No
assistant screen or message endpoint was used by that dwell.

Verification snapshots: test all-events **17:41:41Z–17:42:36Z**;
test non-synthetic **17:41:41Z–17:42:41Z**; production all-events
**17:19:23Z–17:20:25Z** and production non-synthetic through **17:21:32Z**,
all on **2026-10-28 UTC**. Each verifier exited **1** for missing product inputs;
there were **0 API/query errors**. No `--allow-empty` override was used.

## Per-insight results

All **59/59 managed saved insights** were found by API name/ID. A read-only
source audit at 2026-10-28T17:35:45Z confirmed all 59 saved query payloads match
the repository definitions (ignoring server-added fields). Tables cover
35 product insights, 21 LLM dashboard insights, and 3 saved trace filters. Test
uses 7 days; production uses 30. Cells show **data yes/no (result rows)**, not event
counts. Zero-filled native series can have result rows with no input data. A valid
0%/zero-cost row with real denominator/input counts as data. Funnel/cohort input
does not prove conversion or mature week-1/week-4 retention.

The non-synthetic pass adds `NOT coalesce(properties.synthetic, false)` and
excludes distinct ID `synthetic-x6-validation` at every event scan. Native series,
retention entities and formula-denominator probes receive the equivalent HogQL
filter. Logs stay unchanged; event flags cannot filter the separate logs table.
No data was deleted. LLM `empty (allowed)` means a successful empty query, not
data or acceptance.

| Scope                    | Test data / 59 | Production data / 59 | Query errors | Exit                 |
| ------------------------ | -------------: | -------------------: | -----------: | -------------------- |
| All events               |             49 |                    3 |            0 | test 1; production 1 |
| Without synthetic events |             40 |                    3 |            0 | test 1; production 1 |

Production has scoped input only for API p95 and 5xx rate. The shared quota chart
intentionally spans **all environments**; its `yes` in the production columns
proves global traffic, **not production LLM traffic**.

### Product insights

| Dashboard · insight                                      | API ID   | Test     | Test non-synthetic | Production | Production non-synthetic |
| -------------------------------------------------------- | -------- | -------- | ------------------ | ---------- | ------------------------ |
| Product overview · DAU / WAU / MAU                       | 13296081 | yes (3)  | yes (3)            | no (0)     | no (0)                   |
| Product overview · Active stores                         | 13296083 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Product overview · New stores per week                   | 13296084 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Product overview · Week-1 and week-4 retention           | 13296085 | yes (2)  | yes (2)            | no (5)     | no (5)                   |
| Product overview · Stickiness                            | 13296086 | yes (1)  | yes (1)            | no (1)     | no (1)                   |
| Product overview · Sales per active store per day        | 13296087 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Product overview · Revenue per day                       | 13296088 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Product overview · Payment method mix including credit   | 13296089 | yes (6)  | yes (5)            | no (0)     | no (0)                   |
| Activation funnel · Conversion by sign-in method         | 13296090 | yes (1)  | no (0)             | no (0)     | no (0)                   |
| Activation funnel · Time to convert by sign-in method    | 13296091 | yes (1)  | no (0)             | no (0)     | no (0)                   |
| Checkout and recognition · Scans by match class          | 13296092 | yes (3)  | yes (3)            | no (0)     | no (0)                   |
| Checkout and recognition · Unknown rate                  | 13296093 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Checkout and recognition · Scan latency p95              | 13296094 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Checkout and recognition · Sales with manual lines share | 13296095 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Checkout and recognition · Voids per 100 sales           | 13296096 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Receipts and stock · Scan to confirmation by via         | 13296102 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Receipts and stock · Receipt lines matched share         | 13296103 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Receipts and stock · Stock adjustments by reason and via | 13296104 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Assistant adoption · Opens by entry                      | 13296105 | yes (1)  | no (0)             | no (0)     | no (0)                   |
| Assistant adoption · Weekly users sending a message      | 13296106 | yes (1)  | no (0)             | no (0)     | no (0)                   |
| Assistant adoption · Messages per user                   | 13296107 | yes (1)  | no (0)             | no (0)     | no (0)                   |
| Assistant adoption · Action confirm rate by kind         | 13296108 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Assistant adoption · Feedback ratio                      | 13296109 | yes (1)  | no (0)             | no (0)     | no (0)                   |
| Assistant adoption · Next-step CTR by kind and position  | 13296110 | yes (4)  | yes (2)            | no (0)     | no (0)                   |
| Assistant adoption · Voice input share and success       | 13296111 | yes (1)  | no (0)             | no (0)     | no (0)                   |
| Assistant adoption · Digest open rate (card vs push)     | 13296112 | yes (1)  | no (0)             | no (0)     | no (0)                   |
| Debt book · Credit sales share                           | 13296113 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Debt book · Debts recorded vs repaid per week            | 13296114 | yes (3)  | yes (3)            | no (0)     | no (0)                   |
| Debt book · Customers created                            | 13296115 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Debt book · Overdue reminder shares                      | 13296116 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Reliability · Exceptions trend                           | 13296117 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Reliability · Crash-free sessions                        | 13296119 | yes (1)  | yes (1)            | no (0)     | no (0)                   |
| Reliability · Backend error logs per route               | 13296120 | no (0)   | no (0)             | no (0)     | no (0)                   |
| Reliability · API p95 per route                          | 13296121 | yes (69) | yes (69)           | yes (4)    | yes (4)                  |
| Reliability · 5xx rate                                   | 13296122 | yes (69) | yes (69)           | yes (4)    | yes (4)                  |

### LLM insights

| Dashboard · insight                                       | API ID   | Test    | Test non-synthetic | Production | Production non-synthetic |
| --------------------------------------------------------- | -------- | ------- | ------------------ | ---------- | ------------------------ |
| Assistant health · Turns per day by environment           | 13391419 | yes (3) | yes (3)            | no (0)     | no (0)                   |
| Assistant health · Turn latency p50 / p95                 | 13391420 | yes (3) | yes (3)            | no (0)     | no (0)                   |
| Assistant health · Time to first token p50 / p95 by model | 13391421 | yes (5) | yes (5)            | no (0)     | no (0)                   |
| Assistant health · Model calls per turn                   | 13391422 | no (0)  | no (0)             | no (0)     | no (0)                   |
| Assistant health · Error and quota rate                   | 13391423 | yes (3) | yes (3)            | no (0)     | no (0)                   |
| Assistant health · Fallback rate by model                 | 13391424 | yes (5) | yes (5)            | no (0)     | no (0)                   |
| Cost and tokens · Input / output tokens per day by model  | 13391425 | yes (7) | yes (7)            | no (0)     | no (0)                   |
| Cost and tokens · Tokens per turn p50 / p95               | 13391427 | no (0)  | no (0)             | no (0)     | no (0)                   |
| Cost and tokens · Cost per day by model                   | 13391428 | yes (7) | yes (7)            | no (0)     | no (0)                   |
| Cost and tokens · Requests vs. 1,000/day free quota       | 13391429 | yes (3) | yes (3)            | yes (3)    | yes (3)                  |
| Tools and actions · Tool calls per day by tool            | 13391430 | yes (9) | yes (9)            | no (0)     | no (0)                   |
| Tools and actions · Tool error and denied rate by tool    | 13391431 | yes (3) | yes (3)            | no (0)     | no (0)                   |
| Tools and actions · Tool latency p95 by tool              | 13391432 | yes (3) | yes (3)            | no (0)     | no (0)                   |
| Tools and actions · Use-case mix                          | 13391433 | yes (2) | yes (2)            | no (0)     | no (0)                   |
| Tools and actions · Proposed action outcomes by kind      | 13391434 | yes (1) | yes (1)            | no (0)     | no (0)                   |
| Tools and actions · Next-step turns by kind               | 13391435 | no (0)  | no (0)             | no (0)     | no (0)                   |
| Tools and actions · Next-step chip to turn                | 13391436 | yes (1) | no (0)             | no (0)     | no (0)                   |
| Quality · User feedback (thumbs) over time                | 13391437 | yes (3) | yes (3)            | no (0)     | no (0)                   |
| Quality · Eval scores per run by model                    | 13391438 | no (0)  | no (0)             | no (0)     | no (0)                   |
| Quality · Eval pass rate by use case                      | 13391439 | no (0)  | no (0)             | no (0)     | no (0)                   |
| Quality · Online judge score on production sample         | 13391440 | no (0)  | no (0)             | no (0)     | no (0)                   |

### Saved trace filters

| Dashboard · insight                 | API ID   | Test   | Test non-synthetic | Production | Production non-synthetic |
| ----------------------------------- | -------- | ------ | ------------------ | ---------- | ------------------------ |
| Assistant traces · Errors           | 13391441 | no (0) | no (0)             | no (0)     | no (0)                   |
| Assistant traces · Quota hits       | 13391442 | no (0) | no (0)             | no (0)     | no (0)                   |
| Assistant traces · Rejected actions | 13391443 | no (0) | no (0)             | no (0)     | no (0)                   |

### Spec rows without saved insights: Users and stores

None of these four names exists in the managed definitions or API insight list.
The values below are supplementary read-only HogQL results, **not saved-chart
acceptance**; no dashboard was created in this task. Snapshot: 2026-10-28T17:24:01.184Z.

| Spec row                          | Saved insight | Test     | Test non-synthetic | Production | Production non-synthetic |
| --------------------------------- | ------------- | -------- | ------------------ | ---------- | ------------------------ |
| Active assistant users per day    | missing       | yes (3)  | yes (3)            | no (0)     | no (0)                   |
| Top users by turns                | missing       | yes (10) | yes (10)           | no (0)     | no (0)                   |
| Turns per store                   | missing       | yes (19) | yes (19)           | no (0)     | no (0)                   |
| Turns per session (thread length) | missing       | no (0)   | no (0)             | no (0)     | no (0)                   |

Query templates below were run with `{{where}}` replaced by the date/environment
predicate, once including all events and once adding both synthetic exclusions.
Top-user identifiers are masked in SQL, and only counts were retained for this table.

```sql
SELECT toStartOfDay(timestamp) AS day, uniqExact(person_id) AS users FROM events WHERE {{where}} AND event = '$ai_trace' GROUP BY day;

SELECT concat(substring(distinct_id,1,8),'…',substring(distinct_id,-4,4)) AS masked_id, countIf(event = '$ai_trace') AS turns, countIf(event = 'assistant_feedback_submitted') AS feedback FROM events WHERE {{where}} AND event IN ('$ai_trace','assistant_feedback_submitted') GROUP BY distinct_id HAVING turns > 0 ORDER BY turns DESC LIMIT 10;

SELECT properties.$groups.store AS store_id, count() AS turns FROM events WHERE {{where}} AND event = '$ai_trace' AND properties.$groups.store IS NOT NULL GROUP BY store_id;

SELECT turns, count() AS threads FROM (SELECT properties.$ai_session_id AS thread, count() AS turns FROM events WHERE {{where}} AND event = '$ai_trace' AND properties.$ai_session_id IS NOT NULL GROUP BY thread) GROUP BY turns;
```

## DoD row 8: logs, error tracking, masked replay

Row 8 is **partial, not passed**: logs and real captured exceptions are present;
masked replay has no received recording to inspect.

Final proof snapshot: **2026-10-28T17:41:47.034Z** (test, last 7 days).

| Signal                            | Received count | Result                              |
| --------------------------------- | -------------: | ----------------------------------- |
| Backend logs                      |         36,810 | yes                                 |
| Error/fatal log entries           |              0 | no error entries; errors view empty |
| Assistant body matches            |            190 | yes                                 |
| `recognition.scan` body matches   |              0 | no                                  |
| Non-synthetic `$exception` events |            216 | yes                                 |
| Distinct exception session IDs    |            128 | yes                                 |
| Test session recordings           |              0 | no; no masking proof                |

All SQL below was executed through read-only `POST /api/projects/<project>/query/`
with `kind=HogQLQuery` and `refresh=force_blocking`. Query POSTs do not capture events.

```sql
SELECT resource_attributes['deployment.environment.name'] AS environment,
       severity_text, count()
FROM logs
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND resource_attributes['service.name'] = 'taphoa-backend'
GROUP BY environment, severity_text
```

The test-only saved-view body-match inventory was:

```sql
SELECT count() AS logs,
       countIf(lower(severity_text) IN ('error', 'fatal')) AS errors_view,
       countIf(position(body, 'assistant') > 0) AS assistant_body_matches,
       countIf(position(body, 'recognition.scan') > 0) AS recognition_body_matches
FROM logs
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND resource_attributes['service.name'] = 'taphoa-backend'
  AND resource_attributes['deployment.environment.name'] = 'test'
```

`GET logs/views/?limit=100` returned three saved views:

| View        | ID                                     | Stored filter                                       |
| ----------- | -------------------------------------- | --------------------------------------------------- |
| errors      | `01a177a2-d360-7981-8649-943f3517cefa` | service `taphoa-backend`; severity error/fatal      |
| assistant   | `01a177a2-d599-74c0-8fdd-654d851be325` | service `taphoa-backend`; search `assistant`        |
| recognition | `01a177a2-d7d8-762d-91e0-780a7aa66c47` | service `taphoa-backend`; search `recognition.scan` |

The body-match counts are a conservative SQL inventory, not proof of the UI
search engine's matching across every attribute. Zero error and recognition body
matches are reported as zero, not as received error/recognition-view data.

```sql
SELECT count() AS exceptions, uniqExact(properties.$session_id) AS sessions
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND properties.environment = 'test' AND event = '$exception'
  AND NOT coalesce(properties.synthetic, false)
  AND distinct_id != 'synthetic-x6-validation'
```

Exception identifiers selected without error text or person properties:

| Event UUID                             | Timestamp UTC                 | Session ID                             |
| -------------------------------------- | ----------------------------- | -------------------------------------- |
| `01a18399-f2ad-749a-9d9d-be0b915df9bb` | `2026-10-28T17:41:07.044000Z` | `01a18399-ebf4-723b-9fb8-b27da748cc20` |
| `01a18399-e760-7aaa-9ab7-9c6822630f75` | `2026-10-28T17:41:04.132000Z` | `01a18399-aea5-767a-9aba-bf69798d08ee` |
| `01a18399-e3b2-7ec0-8658-b93bff41a31a` | `2026-10-28T17:41:03.190000Z` | `01a18399-aea5-767a-9aba-bf69798d08ee` |

A sample received backend log carried the following request identifiers:

- Timestamp: `2026-10-28T17:41:10.882708Z`; route `/v1/products`.
- Trace ID: `457888ecd1ad2ddaf2ca00b3b1d9e619`; span ID: `8b3a2574d0d3e323` (decoded from API base64).

```sql
SELECT timestamp, trace_id, span_id, attributes['http.route'] AS route FROM logs WHERE timestamp >= now() - INTERVAL 7 DAY AND resource_attributes['service.name'] = 'taphoa-backend' AND resource_attributes['deployment.environment.name'] = 'test' ORDER BY timestamp DESC LIMIT 3
```

The official [session-recordings list API](https://posthog.com/docs/api/session-recordings)
was queried with `GET session_recordings/?limit=10&date_from=-7d&properties=<url-encoded JSON>`:

```json
[
  {
    "key": "environment",
    "value": ["test"],
    "type": "event",
    "operator": "exact"
  }
]
```

Result: **0 recordings**, `has_next=false`, IDs `[]`. An unfiltered project list
also returned `[]`. No recording payload or PII was downloaded. This does not
prove masking. Project GET confirms `session_recording_opt_in=true` and
`autocapture_exceptions_opt_in=true`, while project masking config is null.
`apps/mobile/src/lib/analyticsPostHog.tsx` configures `maskAllTextInputs`,
`maskAllImages`, `maskAllSandboxedViews`, and disables replay network/console
capture. These settings show intent only. Installed `posthog-react-native@4.83.0`
loads its optional replay plugin only when the platform is not web. Real native
Android/iOS traffic, recording IDs, and inspection of masked output are still
required; a Playwright web run cannot prove native replay delivery.

## DoD row 9: Clerk identity and store linkage

At **2026-10-28T17:24:00Z**, the read-only event query returned fresh real app
activity with Clerk identity and store linkage:

```sql
SELECT toString(uuid), event, timestamp,
       concat(substring(distinct_id, 1, 8), '…',
              substring(distinct_id, -4, 4)) AS masked_clerk_id,
       properties.$groups.store AS store_id
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND properties.environment = 'test'
  AND distinct_id LIKE 'user_%'
  AND properties.$groups.store IS NOT NULL
  AND NOT coalesce(properties.synthetic, false)
ORDER BY timestamp DESC LIMIT 5
```

| Event UUID                             | Event             | Timestamp UTC              | Masked distinct ID | `$groups.store`                        |
| -------------------------------------- | ----------------- | -------------------------- | ------------------ | -------------------------------------- |
| `01a18389-b280-7672-8ae0-5ebd657e124d` | `$screen`         | `2026-10-28T17:23:22.011Z` | `user_3LK…Xlw2`    | `7577dd2f-9cc7-4b98-ac9e-4d2bd4e781e3` |
| `01a18389-8df4-7b60-af1a-04c147cb7e44` | `next_step_shown` | `2026-10-28T17:23:12.624Z` | `user_3LK…Xlw2`    | `7577dd2f-9cc7-4b98-ac9e-4d2bd4e781e3` |

The same result set included real `$exception` events with this linkage. No
person names, emails, or complete Clerk IDs were selected. **Row 9 passes** for
app events. Backend product events still use member UUIDs: the live member lookup
in `apps/backend/crates/api/src/events/product_events.rs` selects
`id::text AS distinct_id`. Aligning those events with Clerk users is a separate
backend fix; the browser event proof does not claim backend identity parity.

A separate logs query also found a request trace with
`user.id=user_3LK…UMlK`, store `fe535195-94c7-47d8-85d1-5b7d99e099f6`, and trace ID
`RvAssYrerch0q/g1c1hVHA==` (OTLP bytes encoded as base64 by the logs API;
hex `46f02cb18adeadc874abf8357358551c`). The event proof
above is sufficient and uses the requested `$groups.store` field.

## Phase B (assistant traffic after quota reset)

Do not run the traffic commands below before the shared quota resets at 00:00 UTC.
This report does not schedule or automatically execute them after that time.

At the final 7-day test snapshot, these managed LLM insights/filters still had
**no non-synthetic input data**:

- Assistant health · Model calls per turn
- Cost and tokens · Tokens per turn p50 / p95
- Tools and actions · Next-step turns by kind
- Tools and actions · Next-step chip to turn
- Quality · Eval scores per run by model
- Quality · Eval pass rate by use case
- Quality · Online judge score on production sample
- Assistant traces · Errors
- Assistant traces · Quota hits
- Assistant traces · Rejected actions

All environment-scoped LLM insights remain empty in production; only the global
quota insight has rows there. The absent spec row **Turns per session (thread
length)** is also empty in supplementary test SQL. Other absent Users and stores
rows have test input but still need saved chart objects.

After reset, with the same private credentials and a web export still targeting
Railway test:

```bash
export BACKEND_URL=https://backend-test-70c2.up.railway.app
export EXPO_PUBLIC_API_URL="$BACKEND_URL"
# Runs just the real-model smoke; CI must be unset because this spec skips in CI.
env -u CI E2E_ASSISTANT_REAL_MODEL=1 E2E_WEB_EXPORT_READY=1 \
  pnpm --filter @taphoa/mobile exec playwright test \
  e2e-web/assistant-real.spec.ts --project=chromium --no-deps --workers=1

# Four bounded live contract checks; no scripted-provider probe is needed.
BACKEND_URL="$BACKEND_URL" E2E_ASSISTANT_LIVE=1 \
  pnpm --filter @taphoa/e2e run test:e2e tests/assistant-live.test.ts

# Requires EVAL_DATABASE_URL supplied securely for the existing seeded test DB,
# existing eval users/store, and ASSISTANT_ALLOW_EVAL_HEADERS=1 on test.
# The resolver writes GitHub mask directives containing credentials to stderr;
# suppress that stream outside Actions and retain stdout only in the variable.
export EVAL_DATABASE_URL="$(RAILWAY_TOKEN="$RAILWAY_TOKEN_TEST" \
  python3 -I scripts/ci/railway_env.py test 2>/dev/null \
  | sed -n 's/^DATABASE_URL=//p')"
: "${EVAL_DATABASE_URL:?Railway test database resolution failed}"
export POSTHOG_HOST="$POSTHOG_INGEST_HOST"
pnpm --filter @taphoa/eval run identities
pnpm --filter @taphoa/eval run smoke -- --backend "$BACKEND_URL" \
  --concurrency 1 --posthog --out packages/eval/results

node infra/posthog/llm/pricing-verify.mjs
node infra/posthog/llm/evaluations-verify.mjs
node infra/posthog/verify.mjs --environment test --days 7 --json
node infra/posthog/verify-nonsynthetic.mjs --environment test --days 7
node infra/posthog/verify.mjs --environment eval --days 7 --json
node infra/posthog/verify.mjs --environment production --days 30 --json
node infra/posthog/verify-nonsynthetic.mjs --environment production --days 30
```

The eval smoke correctly emits `environment=eval`; never relabel those events to
fill test/production charts. Confirm a new generation includes captured input,
output, trace ID, and price/cost fields; allow automatic judge sampling to ingest,
then query scores joined to target UUIDs. Existing judge proof already passes, so
no manual `evaluations-run --apply` is needed merely to repeat it. Exercise the
app's chip → chat, feedback, proposed-action confirmation/rejection, and voice
flows with the model after reset; one greeting alone cannot fill those metrics.
Production remains read-only in this task. Production LLM/product population
requires actual authorized customer activity or a separately approved production
traffic task; test/eval runs cannot satisfy that acceptance.

## Remaining acceptance gaps and validation

- Production business traffic remains absent; only the existing read-only smoke
  was authorized. Never backfill production with synthetic test events to make
  the dashboard green.
- Retention query at **2026-10-28T17:32:45Z** checked non-synthetic sales over
  60 days: test's first sale was **2026-10-26T10:40:34.718Z**; **0** sales were
  older than 7 days and **0** older than 28 days. A populated cohort table is
  not observed week-1/week-4 returning retention; those cohorts need time.
- Replay receipt/masking remains unproven. Run a native test build against Railway
  test with the existing masking options, then query recordings and inspect
  masking before marking row 8 done.
- The spec's four **Users and stores** charts are absent from the managed/applied
  dashboards. Supplementary SQL above checks their underlying data without
  creating insights; it does not prove those missing chart objects exist.
- The online-judge chart reads `eval_case_scored` with `scorer=judge`, rather than
  the configured PostHog `$ai_evaluation` results. At **2026-10-28T17:21:20Z**,
  `evaluations-verify.mjs` exited 0: evaluation
  `01a182a2-bbe6-0000-92f8-955540555f4b`, configuration matches, active/enabled,
  **26** linked test scores, min **0**, max **4**, across Nemotron Ultra, Laguna,
  and Lightning. This is judge-data proof, not chart-data proof or observed
  production 10% sampling. A chart-definition follow-up must join evaluation
  target UUIDs to generation environment; evaluation events need not carry it.
- Grouped LLM trace/thread metrics need correctly populated `$ai_trace_id`,
  `$ai_session_id`, and `next_step_kind`; do not manufacture missing historical
  fields. Backend product distinct IDs also need the separate Clerk alignment
  described under row 9.
- Screenshots remain with the controller; no screenshot acceptance is claimed.

The complete corrected Chromium run (**2026-10-28T17:21:05Z–17:36:33Z**)
selected 67 non-assistant tests: **29 passed, 38 failed**, exit **1**, one retry
per failing test. No tests were skipped in that run. The initial aborted
selection was 17:17:29Z–17:20:26Z, exit 143; its assistant preflight incident is
described above. The corrected `--list` contained only 13 non-assistant files.

| Functional spec        | Passed | Failed |
| ---------------------- | -----: | -----: |
| `account.spec.ts`      |      6 |      1 |
| `camera.spec.ts`       |      6 |      1 |
| `checkout.spec.ts`     |      0 |      4 |
| `close.spec.ts`        |      0 |      3 |
| `debts.spec.ts`        |      0 |      1 |
| `expense.spec.ts`      |      0 |      4 |
| `inventory.spec.ts`    |      3 |      3 |
| `onboarding.spec.ts`   |      1 |      5 |
| `quick-enroll.spec.ts` |      1 |      1 |
| `receipts.spec.ts`     |      0 |      1 |
| `recognition.spec.ts`  |      1 |      4 |
| `reports.spec.ts`      |      4 |      2 |
| `screens.spec.ts`      |      7 |      8 |

Checkout-only recovery run: **17:36:53Z–17:37:59Z**, **4 failed, 0 passed**,
exit **1**, no retries. All four failures still reported unknown-module errors;
**none** reported `ERR_CONNECTION_REFUSED`. The local server was reachable again.
The recovery therefore distinguishes persistent export/runtime errors from the
initial server outage; it does not turn the functional suite green.

The isolated performance project used `--no-deps --workers=1 --retries=0`:
**17:37:59Z–17:38:58Z**, **1 failed, 1 did not run**, exit **1**. Its serial group
stopped after the unthrottled case failed. The throttled 4x CPU case was then
selected independently with the same file/project options and
`--grep 'throttled 4x CPU'`: **17:40:09Z–17:41:11Z**, **1 failed**, exit **1**.
Both cases were attempted; no passing performance-budget claim is made. Unknown
module errors persisted in the performance browser error guard as well.

```bash
env -u CI E2E_WEB_EXPORT_READY=1 pnpm --filter @taphoa/mobile exec playwright test \
  e2e-web/checkout.spec.ts --project=chromium --workers=2 --retries=0
env -u CI E2E_WEB_EXPORT_READY=1 pnpm --filter @taphoa/mobile exec playwright test \
  e2e-web/perf.spec.ts --project=perf --no-deps --workers=1 --retries=0 \
  --grep 'throttled 4x CPU'
```

The functional run also exposed persistent `pageerror: Requiring unknown module`
errors during route transitions (for example modules 790/791 on sign-out,
3842/3951 on the stock route, and 4153 on expense). These remain application/web
export follow-ups; no root cause is claimed from module IDs alone. A local
`expo serve` process exit caused `ERR_CONNECTION_REFUSED` for lazy cart chunks
and subsequent sign-in navigations; serving the same completed `dist-web` export
was restarted at approximately 17:26 UTC. Infrastructure-affected failures and
persistent module errors are both retained in the totals. Assertions were not
weakened and no backend/mobile code was changed.

New-script tests were written first: the initial `node --test
infra/posthog/tests/nonsynthetic.test.mjs` failed because the module did not yet
exist. After implementation, all four new tests passed. Coverage includes nested
event SQL scans, all 59 managed query shapes, retention entities, formula
denominator probes, global quota scope, unchanged log queries, read-only query
routing, empty reports, and fail-closed unsupported SQL. Final validation:

```bash
node --test infra/posthog/tests infra/posthog/llm/*.test.mjs
# 64 passed, 0 failed (Node 24.21.0)
pnpm --filter @taphoa/mobile lint
# exit 0
pnpm --filter @taphoa/mobile typecheck
# exit 0
```

`pnpm exec prettier --check docs/specs/assistant/dod/traffic-proof.md infra/posthog`
passed, as did `git diff --check`. A scan of the four changed files found no
configured key/token/secret values. Temporary local static serving was stopped
after evidence collection.

No Rust build or `cargo clean` was run. No PR was pushed/merged. This worktree
must remain because its branch is unmerged; no cleanup of other worktrees is
appropriate for this task. `git worktree list` reported 40
registered worktrees; this branch/worktree remains among them, and none was
removed.

## Production smoke

Owner decision: issue #66's latest owner comment authorizes real production use in
one dedicated test store. This section supersedes Phase A's production read-only
restriction and screenshot reservation. It does **not** mark all dashboard DoD rows
complete.

### Identity, isolation and timing

- Backend: `https://backend-production-5f5c.up.railway.app`, confirmed with
  `RAILWAY_TOKEN="$RAILWAY_TOKEN_PRODUCTION" railway status --json`.
- Active successful deployment at readback: `f768357b-932a-4c01-9a2a-a753c7a246a3`,
  commit `c043856131b437a33477066b0ddbb653ca89947f`. A stopped/building deployment was
  also listed; no deploy or configuration change was performed here.
- Local source rebased onto `origin/main`: `16b00fb`. This is not a claim that the
  deployed backend runs that revision.
- Dedicated Clerk user: `user_3LK…BnUQ`; masked email
  `smoke-prod-x9+…@example.com`. The fixed development-instance `+clerk_test`
  identity is reused, never deleted by Playwright teardown.
- Store: **Smoke test (X9) - do not use**,
  `318e7cdf-8132-47a1-b902-cc806ec59121`.
- Lead member: `48771b76-d16e-4e62-b4f4-e153662f5b98`.
- Provisioning began **2026-10-28T19:29:01Z**; product flow completed through day
  close in **19:34:47Z–19:37:08Z**; assistant recovery completed in
  **19:38:47Z–19:41:36Z**. All dates/times here are UTC (the store's business date
  was **2026-10-29**).

The script refuses a fixed user with any membership outside the single named smoke
store. Browser writes are intercepted and refused unless `X-Store-Id` is that store;
initial onboarding alone may create the named store. Node-side writes use the same
validated membership and scoped API client. **Zero blocked/out-of-scope writes**
were observed. No other store/user was edited, no PostHog event was fabricated or
deleted, and no production rate limit, model provider, eval header, flag, dashboard
or backend variable was changed.

### Flow and recovery evidence

The flow exercised real email/code sign-in, first-run onboarding, three product
enrollments, fake-webcam capture through real production recognition, a UI cash
checkout, a manual-line sale and void, a credit sale, UI debt repayment, inventory
and stock screens, day/week reports, receipt OCR and confirmation, digest-card
entry, and day close. Product creation, credit-sale seeding, stock adjustments and
receipt confirmation use the real scoped API; camera checkout, repayment and day
close use the UI. Nothing mocks production responses. The receipt fixture's
retained lines were explicitly mapped to the smoke product and paid from `other`.
The digest screen was opened; no push delivery or generated digest content is claimed.

Exactly **four real assistant messages** were sent across two threads. The first
three requests were short Vietnamese questions about sales, low stock and a
1,000đ electricity-expense proposal. The fourth came from the **restock next-step
chip**. All four persisted replies identify
`nvidia/nemotron-3-ultra-550b-a55b:free`. A thumbs-up was stored on the first reply;
the proposed expense was **rejected**, so it made no expense write.

- Main thread: `01a18403-dd2a-759f-9382-40fe5ec94699` (three replies).
- Chip thread: `01a18406-dca2-75ba-b290-0614e7f970d7` (one reply).
- Rejected expense action: `01a18406-9bb2-7365-9b6f-c2629de69fc6`.
- Receipt: `01a18403-4916-7460-b6c6-2c62a67b4323`, confirmed.
- Final readback at **19:43:58Z**: one membership, three products, one smoke
  customer with **0đ balance**, four persisted assistant replies, thumbs-up, and
  the expense action in `rejected` status. No pending assistant actions remained.

The first complete attempt was recovered in stages because of harness mistakes:
request-body assertions depended on fixtures intentionally excluded from this
project; the void request initially omitted its required reason; direct navigation
to a dynamic customer URL returned static-host 404; Chromium could not retrieve a
completed SSE body. These were corrected to observe response data, supply the
reason, navigate through the debt list, and assert rendered completion plus the
persisted backend reply. Earlier attempts produced tagged product activity within
the smoke store. The fourth attempt completed all product steps and the first LLM
reply. The final **resumed Playwright run passed (1/1, 2.9 minutes)**, reused that
reply and sent only the remaining three messages. A fresh uninterrupted default
run after those repairs was not repeated, to preserve the four-message budget.
The optional `E2E_SMOKE_RESUME_THREAD` mode explicitly skips already-covered product
steps and requires the supplied smoke-store thread to contain that first exchange.

Machine-readable run evidence and all 59 rows for each verification scope are in
[production-smoke-results.json](production-smoke-results.json). It contains masked
identity, IDs, model names, counts and outcomes, without tokens or reply content.

### Reproduce

Use Node 24 and pnpm 11.5.0 from the repository root. The regular Chromium/perf
projects exclude this spec; the opt-in environment selects only `production-smoke`.
Never use the normal fresh-store fixtures on production.

```bash
pnpm install --frozen-lockfile
apps/mobile/e2e-web/fixtures/make-video.sh
set -a
source ~/.config/taphoa-mini/secrets.env
set +a
export EXPO_PUBLIC_API_URL=https://backend-production-5f5c.up.railway.app
export EXPO_PUBLIC_ENVIRONMENT=production
export EXPO_PUBLIC_SMOKE=1
export EXPO_PUBLIC_POSTHOG_KEY="$POSTHOG_PROJECT_TOKEN"
export EXPO_PUBLIC_POSTHOG_HOST="$POSTHOG_INGEST_HOST"
export E2E_PRODUCTION_SMOKE=1
export E2E_WEB_PORT=8106
CI=1 pnpm --filter @taphoa/mobile exec playwright test \
  --project=production-smoke --workers=1
# E2E_WEB_EXPORT_READY=1 can reuse only this same production/smoke export.
# Recovery only, after checking the persisted first exchange:
# E2E_WEB_EXPORT_READY=1 E2E_SMOKE_RESUME_THREAD=<thread UUID> CI=1 \
#   pnpm --filter @taphoa/mobile exec playwright test --project=production-smoke --workers=1

node infra/posthog/verify.mjs --environment production --days 1 --json
node infra/posthog/verify-nonsynthetic.mjs --environment production --days 1
node infra/posthog/verify.mjs --environment production --days 1 \
  --only-store 318e7cdf-8132-47a1-b902-cc806ec59121 --json
node infra/posthog/verify-nonsynthetic.mjs --environment production --days 1 \
  --exclude-store 318e7cdf-8132-47a1-b902-cc806ec59121
node infra/posthog/export-dashboards.mjs
```

### Verification

Final production all-events verification completed **19:43:33Z**, non-synthetic
**19:43:40Z**, smoke-store-only **19:43:56Z**, and test refresh **19:43:49Z**.
All use a **one-day** lookback. The earlier test run had one PostHog 504 for TTFT;
a focused retry and the final complete test refresh succeeded. Final query error
count is **zero** in every scope. The production verifiers exit **1** because three
product insights remain empty; empty LLM rows are reported as allowed by existing
verifier behavior, not as passing traffic acceptance. No allow-empty override was used.

| Scope                        | Insights with input / 59 | Query errors | Exit |
| ---------------------------- | -----------------------: | -----------: | ---: |
| Production before smoke      |                        4 |            0 |    1 |
| Production, all events       |                       49 |            0 |    1 |
| Production, non-synthetic    |                       49 |            0 |    1 |
| Production, smoke store only |                       49 |            0 |    1 |
| Test refresh, all events     |                       47 |            0 |    1 |

The shared quota and online-judge charts intentionally span **all environments**.
Their rows remain global even with `--only-store`; they are not proof of production
quota consumption or this smoke's 10% judge sampling. Thus 49 includes two global
charts; 47 populated insights are environment/store-scoped. Cells below show
**data yes/no (result rows)**, not event counts, completed funnels or retention.

| Insight                                                   | Production | Non-synthetic | Smoke store only | Test refresh |
| --------------------------------------------------------- | ---------- | ------------- | ---------------- | ------------ |
| Product overview · DAU / WAU / MAU                        | yes (3)    | yes (3)       | yes (3)          | yes (3)      |
| Product overview · Active stores                          | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Product overview · New stores per week                    | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Product overview · Week-1 and week-4 retention            | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Product overview · Stickiness                             | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Product overview · Sales per active store per day         | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Product overview · Revenue per day                        | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Product overview · Payment method mix including credit    | yes (2)    | yes (2)       | yes (2)          | yes (5)      |
| Activation funnel · Conversion by sign-in method          | no (0)     | no (0)        | no (0)           | no (0)       |
| Activation funnel · Time to convert by sign-in method     | no (0)     | no (0)        | no (0)           | no (0)       |
| Checkout and recognition · Scans by match class           | yes (1)    | yes (1)       | yes (1)          | yes (3)      |
| Checkout and recognition · Unknown rate                   | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Checkout and recognition · Scan latency p95               | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Checkout and recognition · Sales with manual lines share  | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Checkout and recognition · Voids per 100 sales            | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Receipts and stock · Scan to confirmation by via          | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Receipts and stock · Receipt lines matched share          | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Receipts and stock · Stock adjustments by reason and via  | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Assistant adoption · Opens by entry                       | yes (2)    | yes (2)       | yes (2)          | yes (1)      |
| Assistant adoption · Weekly users sending a message       | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Assistant adoption · Messages per user                    | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Assistant adoption · Action confirm rate by kind          | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Assistant adoption · Feedback ratio                       | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Assistant adoption · Next-step CTR by kind and position   | yes (5)    | yes (5)       | yes (5)          | yes (2)      |
| Assistant adoption · Voice input share and success        | yes (1)    | yes (1)       | yes (1)          | no (0)       |
| Assistant adoption · Digest open rate (card vs push)      | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Debt book · Credit sales share                            | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Debt book · Debts recorded vs repaid per week             | yes (2)    | yes (2)       | yes (2)          | yes (3)      |
| Debt book · Customers created                             | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Debt book · Overdue reminder shares                       | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Reliability · Exceptions trend                            | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Reliability · Crash-free sessions                         | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Reliability · Backend error logs per route                | no (0)     | no (0)        | no (0)           | no (0)       |
| Reliability · API p95 per route                           | yes (32)   | yes (32)      | yes (27)         | yes (65)     |
| Reliability · 5xx rate                                    | yes (32)   | yes (32)      | yes (27)         | yes (65)     |
| Assistant health · Turns per day by environment           | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Assistant health · Turn latency p50 / p95                 | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Assistant health · Time to first token p50 / p95 by model | yes (1)    | yes (1)       | yes (1)          | yes (3)      |
| Assistant health · Model calls per turn                   | no (0)     | no (0)        | no (0)           | no (0)       |
| Assistant health · Error and quota rate                   | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Assistant health · Fallback rate by model                 | yes (1)    | yes (1)       | yes (1)          | yes (5)      |
| Cost and tokens · Input / output tokens per day by model  | yes (1)    | yes (1)       | yes (1)          | yes (5)      |
| Cost and tokens · Tokens per turn p50 / p95               | no (0)     | no (0)        | no (0)           | no (0)       |
| Cost and tokens · Cost per day by model                   | yes (1)    | yes (1)       | yes (1)          | yes (5)      |
| Cost and tokens · Requests vs. 1,000/day free quota       | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Tools and actions · Tool calls per day by tool            | yes (4)    | yes (4)       | yes (4)          | yes (3)      |
| Tools and actions · Tool error and denied rate by tool    | yes (4)    | yes (4)       | yes (4)          | yes (3)      |
| Tools and actions · Tool latency p95 by tool              | yes (4)    | yes (4)       | yes (4)          | yes (3)      |
| Tools and actions · Use-case mix                          | yes (4)    | yes (4)       | yes (4)          | yes (2)      |
| Tools and actions · Proposed action outcomes by kind      | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Tools and actions · Next-step turns by kind               | yes (1)    | yes (1)       | yes (1)          | no (0)       |
| Tools and actions · Next-step chip to turn                | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Quality · User feedback (thumbs) over time                | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Quality · Eval scores per run by model                    | no (0)     | no (0)        | no (0)           | no (0)       |
| Quality · Eval pass rate by use case                      | no (0)     | no (0)        | no (0)           | no (0)       |
| Quality · Online judge score on production sample         | yes (1)    | yes (1)       | yes (1)          | yes (1)      |
| Assistant traces · Errors                                 | no (0)     | no (0)        | no (0)           | no (0)       |
| Assistant traces · Quota hits                             | no (0)     | no (0)        | no (0)           | no (0)       |
| Assistant traces · Rejected actions                       | no (0)     | no (0)        | no (0)           | no (0)       |

### Empty charts and practical limits

| Insight / group                                                     | Reason and next step                                                                                                                                                                                                                                                                                                                                                  | Cheap flow addition?                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activation conversion; time to convert                              | No `signed_in` event is emitted by current mobile source (`signed_in` appears only in the analytics contract type outside tests). Real email/code login was exercised repeatedly. The time chart also needs an ordered completed activation funnel.                                                                                                                   | A producer fix is needed; replaying UI login cannot supply an absent emitter. Do not fabricate sign-ins or create another production store to inflate conversion. |
| Backend error logs per route                                        | No qualifying backend error-level log input. Successful access logs populate p95 and 5xx-rate charts.                                                                                                                                                                                                                                                                 | No deliberate production fault was introduced.                                                                                                                    |
| Model calls per turn; tokens per turn; rejected-action trace filter | **Fixed by definitions update** (separate worker, per owner clarification). PostHog moves reserved AI fields, including trace ID, into `posthog.ai_events`; reading `events.properties.$ai_trace_id` cannot group those rows. The actual four replies and rejected action are persisted and independently verified. This table runs the local pre-update definitions. | No more model traffic or backend deploy is needed. Refresh verification after integrating/applying that definitions change.                                       |
| Error / quota trace filters                                         | The same trace-column definitions update applies; additionally this bounded successful flow hit no assistant error or quota.                                                                                                                                                                                                                                          | No intentional quota exhaustion or failing turn was added.                                                                                                        |
| Eval scores; eval pass rate                                         | Harness events correctly use `environment=eval`. A production app session emits no eval-case scores.                                                                                                                                                                                                                                                                  | Do not relabel eval results as production.                                                                                                                        |

Cheap coverage additions were already included: three enrollments, a manual sale
and void, credit/repayment, stock adjustments, receipt scan/confirmation, digest
screen opening, and a real restock chip. No further rerun can cheaply fill the
remaining missing producers/definitions/eval inputs. The final verifier confirms
those additions have scoped input.

Retention has a new real sales cohort, **not observed week-1/week-4 return
retention**. Voice input share is a valid **0%** with message-denominator evidence;
there were no `voice_input_used` events and no Android/iOS voice or push run.
Digest evidence is the card entry's real `digest_opened`, not a push receipt or a
true exposure-to-open rate. Real app `$exception` events were received during the
web runs; this is traffic proof, not a claim of an exception-free application.
No new replay-masking acceptance or missing Users-and-stores dashboard provisioning
is claimed by this task.

### Tagging and cleanup decision

**Retain and tag**, so the same user/store can be reused. The store and products
are explicitly named smoke fixtures; the customer balance is zero and the assistant
expense was rejected. Backend events carry `$groups.store` with the store UUID;
app events additionally carry `smoke=true` from `EXPO_PUBLIC_SMOKE=1`. No production
backend flag/deploy is required. The flag persists across analytics reset/sign-out
and is absent from ordinary builds. Initial pre-membership app events can lack a
store group, which is why the smoke property is also useful.

Use this event predicate to exclude all current smoke traffic in HogQL (including
pre-store app events):

```sql
NOT coalesce(properties.smoke, false)
AND coalesce(properties.$groups.store, '') != '318e7cdf-8132-47a1-b902-cc806ec59121'
```

To inspect just the store:

```sql
properties.environment = 'production'
AND properties.$groups.store = '318e7cdf-8132-47a1-b902-cc806ec59121'
```

For backend logs, use
`coalesce(attributes['taphoa.store.id'], '') != '318e7cdf-8132-47a1-b902-cc806ec59121'`.
The CLI's optional `--exclude-store` / `--only-store` apply the group/store-log
predicate at every supported scan/entity, including formula denominators; the CLI
store option alone does not exclude ungrouped app events via `smoke`. Native entities
receive equivalent HogQL predicates. Unsupported SQL fails closed, and the two
intentionally global charts remain global. The separate `posthog.ai_events`
definitions update needs its corresponding store-filter query mapping when integrated.
No PostHog event/person/group deletion was performed.

### Dashboard screenshots

All **seven product dashboards and four LLM dashboards** were exported through
`POST /api/projects/{id}/exports/`, polled until `has_content`, and downloaded from
`exports/{id}/content/`. The signed PNG URL is fetched **without Authorization**.
The script checks the PNG signature and writes a manifest of dashboard/export IDs.

These are refreshed **saved all-environment snapshots**, containing both test and
production aggregates; they do not replace the production-only tables above. Per
the controller's clarification, one timestamped set is kept instead of duplicated
`production/` and `test/` images or extra environment-copy dashboards. No temporary
filter or dashboard mutation was performed. The earlier pre-completion export set
was replaced locally by this refreshed set; no remote PostHog data was deleted.

| Dashboard                | Exported PNG                                                             |
| ------------------------ | ------------------------------------------------------------------------ |
| Product overview         | [PNG](screenshots/2026-10-28T19-40-36-947Z-product-overview.png)         |
| Activation funnel        | [PNG](screenshots/2026-10-28T19-40-36-947Z-activation-funnel.png)        |
| Checkout and recognition | [PNG](screenshots/2026-10-28T19-40-36-947Z-checkout-and-recognition.png) |
| Receipts and stock       | [PNG](screenshots/2026-10-28T19-40-36-947Z-receipts-and-stock.png)       |
| Assistant adoption       | [PNG](screenshots/2026-10-28T19-40-36-947Z-assistant-adoption.png)       |
| Debt book                | [PNG](screenshots/2026-10-28T19-40-36-947Z-debt-book.png)                |
| Reliability              | [PNG](screenshots/2026-10-28T19-40-36-947Z-reliability.png)              |
| Assistant health         | [PNG](screenshots/2026-10-28T19-40-36-947Z-assistant-health.png)         |
| Cost and tokens          | [PNG](screenshots/2026-10-28T19-40-36-947Z-cost-and-tokens.png)          |
| Tools and actions        | [PNG](screenshots/2026-10-28T19-40-36-947Z-tools-and-actions.png)        |
| Quality                  | [PNG](screenshots/2026-10-28T19-40-36-947Z-quality.png)                  |

[Export manifest](screenshots/2026-10-28T19-40-36-947Z-manifest.json). The start timestamp is
**2026-10-28T19:40:36Z**; dashboards export sequentially.

### Validation and delivery

- Node 24.21.0 / pnpm 11.5.0; `node --test infra/posthog/tests`: **41/41 passed**.
- Touched analytics Jest suite: **27/27 passed** (`--runInBand --watchman=false`).
- Mobile lint and typecheck: **passed** after the final smoke harness repair.
- Prettier and `git diff --check`: **passed**.
- Default Chromium discovery: **71 tests in 15 files**, with no production-smoke spec.
- Production resume: **1/1 passed**; preceding failed attempts and the fresh-run validation limit are recorded above.
- Verification: all **59/59 queried** per scope; **zero final query errors**. Empty rows are reported honestly.
- No Rust build, `cargo clean`, push, PR, merge or deploy. Local commit only; the unmerged worktree is retained.
