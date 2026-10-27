# PostHog dashboards as code

Node 24 ESM, no npm dependencies. These definitions manage the seven X6 product
analytics dashboards (35 insights), three replay playlists, `assistant_enabled`,
three saved log views, store group labels and replay/error project settings.
LLM analytics dashboards belong to X9.

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

# Controller: execute queries to check real data for one environment.
node infra/posthog/verify.mjs --environment test --days 7
# Charts that are empty by design (regex on the insight name) report `empty (allowed)`.
node infra/posthog/verify.mjs --environment test --allow-empty 'Backend error logs'
node infra/posthog/verify.mjs --environment production --days 30 --json
```

`--only` accepts `dashboards`, `flags`, `playlists`, `logs`, `groups` or `settings`.
`--offline` requires `--dry-run`, skips credentials and network entirely, and uses
empty fixtures. Its plan includes 49 creates, one skipped group and one settings
update. A credentialed dry-run reads lists with pagination and returns the planned
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
The table/JSON reports each insight's returned row count and data check; any empty
insight or query error fails the command. Zero-filled native series do not prove
input data. A zero-valued formula also queries its denominator to distinguish a
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

## Add a chart

Edit the dashboard's module in `definitions/` and add a stable suffix, query and
useful description. Native event nodes must use contract event/property names.
For HogQL include `{{environment}}` as a WHERE predicate and `{{days}}` as the
lookback number, and list referenced event names in the chart's fourth tuple
field. Applying renders the environment predicate as `1 = 1`; verifying supplies
the environment predicate and day window. Never interpolate raw CLI input into
SQL. Update the coverage count in `tests/definitions.test.mjs` and this table,
then run the tests and offline plan before controller verification.

The tests inject fake fetch at the HTTP boundary. CI runs only tests and the
offline plan, with no PostHog credentials or requests. `tests/package.json` and
`tests/index.mjs` let Node 24 resolve the explicitly requested test directory.
