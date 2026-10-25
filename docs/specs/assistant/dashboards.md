# Dashboards and charts

Status: Accepted · Date: 2026-10-25 · Program: [README](README.md) · Epics: X6 (PostHog
dashboards as code), X9 (Langfuse dashboards, verification)

Every chart below must exist and show real data from `test` and `production` before DoD row 7
and 8 pass. Each chart names the signal it needs ([telemetry contract](telemetry-contract.md)).
Build dashboards as code where the vendor has an API (PostHog: `infra/posthog/`; Langfuse:
check whether the current version exposes a dashboards API; if not, script the UI with
Playwright and keep the script in `infra/langfuse/`). Scripts are idempotent: rerunning updates
in place.

## Langfuse (self-hosted, project `taphoa`)

Dashboard **Assistant health**

| Chart                                  | Type         | Data                                            |
| -------------------------------------- | ------------ | ----------------------------------------------- |
| Turns per day by environment           | stacked bars | traces `assistant.turn`, `langfuse.environment` |
| Turn latency p50 / p95                 | line         | trace duration                                  |
| Time to first token p50 / p95 by model | line         | `chat` generation attribute                     |
| Model calls per turn                   | histogram    | generations per trace                           |
| Error and quota rate                   | line         | trace level ERROR, `quota_hit` score            |
| Fallback rate by model                 | bars         | `taphoa.assistant.fallback_index > 0`           |

Dashboard **Cost and tokens**

| Chart                                  | Type          | Data                                                     |
| -------------------------------------- | ------------- | -------------------------------------------------------- |
| Input / output tokens per day by model | stacked bars  | generation usage                                         |
| Tokens per turn p50 / p95              | line          | trace usage totals                                       |
| Cost per day by model                  | bars          | generation cost (0 for free models; ready for paid ones) |
| Requests vs. 1,000/day free quota      | line + target | generations per day                                      |

Dashboard **Tools and actions**

| Chart                              | Type         | Data                                   |
| ---------------------------------- | ------------ | -------------------------------------- |
| Tool calls per day by tool         | stacked bars | `execute_tool` observations            |
| Tool error and denied rate by tool | bars         | `taphoa.tool.ok`, `taphoa.tool.denied` |
| Tool latency p95 by tool           | bars         | observation duration                   |
| Use-case mix                       | pie          | trace tags `U1`..`U23`                 |
| Proposed action outcomes by kind   | stacked bars | `action_outcome` score                 |
| Next-step chip to turn             | bars         | tags `next_step:<kind>`                |

Dashboard **Quality**

| Chart                                   | Type          | Data                                                                                      |
| --------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| User feedback (thumbs) over time        | line          | `user_feedback` score                                                                     |
| Eval scores per run by model            | grouped bars  | dataset runs: `tool_selection`, `facts`, `judge`, `permission_leak`, `injection_resisted` |
| Eval pass rate by use case              | heatmap/table | dataset run item scores by case tag                                                       |
| Online judge score on production sample | line          | Langfuse LLM-as-judge evaluator on 10 % of production traces                              |

Dashboard **Users and stores**

| Chart                             | Type      | Data                             |
| --------------------------------- | --------- | -------------------------------- |
| Active assistant users per day    | line      | distinct `langfuse.user.id`      |
| Top users by turns                | table     | user id, turns, feedback         |
| Turns per store                   | table     | `store_id` metadata              |
| Turns per session (thread length) | histogram | traces per `langfuse.session.id` |

Also configure: Langfuse model definitions for the free models (so token counts and zero costs
show), the online LLM-as-judge evaluator (OpenRouter connection, free judge model, 10 %
production sampling, Vietnamese rubric), and saved trace views for errors and rejected actions.

## PostHog (Cloud US, project 682994)

Dashboard **Product overview**: DAU / WAU / MAU (persons); active stores (unique `store`
groups); new stores per week; week-1 and week-4 retention (`sale_completed`); stickiness;
sales per active store per day; revenue per day (`sale_completed.total` sum); payment method mix
including credit.

Dashboard **Activation funnel**: `signed_in` → `store_created` → `product_enrolled` (3 or more)
→ `sale_completed` → `day_closed`, conversion and time to convert; breakdown by sign-in method.

Dashboard **Checkout and recognition**: `scan_completed` by `match_class`; unknown rate trend;
scan latency p95; `sale_completed` with `manual_lines > 0` share; voids per 100 sales.

Dashboard **Receipts and stock**: `receipt_scanned` → `receipt_confirmed` funnel split by
`via` (chat vs. form); lines matched share; stock adjustments by reason and `via`.

Dashboard **Assistant adoption**: `assistant_opened` by entry; users who send at least one
message per week; messages per user; `assistant_action_decided` confirm rate by kind;
`assistant_feedback_given` ratio; `next_step_shown` → `next_step_tapped` CTR by kind and
position; `voice_input_used` share and success; digest open rate (card vs. push).

Dashboard **Debt book**: credit sales share; debts recorded vs. repaid per week (counts and
amount buckets); customers created; overdue reminder shares.

Dashboard **Reliability**: error tracking issues trend (`$exception`); crash-free sessions;
backend error logs per route (logs query on severity ≥ error grouped by `http.route`); API
request duration p95 per route (from access logs); 5xx rate.

Also configure: session replay with masking; replay playlists "checkout with manual lines",
"assistant error", "rage taps"; a feature flag `assistant_enabled` (100 %, kill switch read by
the app); saved log views (errors, assistant, recognition); the store group type `store`.
