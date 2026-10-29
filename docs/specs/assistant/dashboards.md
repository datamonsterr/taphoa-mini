# Dashboards and charts

Status: Accepted · Date: 2026-10-25 · Program: [README](README.md) · ADR
[0007](../../adr/0007-posthog-only-observability.md) · Epics: X6 (product dashboards as code),
X9 (LLM analytics dashboards, verification)

Every chart below must exist and show real data from `test` and `production` before DoD rows 7
and 8 pass. Each chart names the signal it needs ([telemetry contract](telemetry-contract.md)).
All dashboards live in PostHog Cloud US (project 682994) and are built as code in
`infra/posthog/` through the PostHog API with the personal API key. Scripts are idempotent:
rerunning updates in place. Start from PostHog's built-in LLM analytics views and add the custom
insights below.

## PostHog LLM analytics (assistant)

Dashboard **Assistant health**

| Chart                                  | Type         | Data                                                   |
| -------------------------------------- | ------------ | ------------------------------------------------------ |
| Turns per day by environment           | stacked bars | `$ai_trace` count, breakdown `environment`             |
| Turn latency p50 / p95                 | line         | `$ai_trace.$ai_latency`                                |
| Time to first token p50 / p95 by model | line         | `$ai_generation.time_to_first_token_ms` by `$ai_model` |
| Model calls per turn                   | histogram    | `$ai_generation` per `$ai_trace_id`                    |
| Error and quota rate                   | line         | `$ai_generation.$ai_is_error`, `assistant_quota_hit`   |
| Fallback rate by model                 | bars         | `$ai_generation.fallback_index > 0`                    |

Dashboard **Cost and tokens**

| Chart                                  | Type          | Data                                                      |
| -------------------------------------- | ------------- | --------------------------------------------------------- |
| Input / output tokens per day by model | stacked bars  | `$ai_input_tokens`, `$ai_output_tokens` by `$ai_model`    |
| Tokens per turn p50 / p95              | line          | token sums per `$ai_trace_id`                             |
| Cost per day by model                  | bars          | PostHog LLM cost (0 for free models; ready for paid ones) |
| Requests vs. 1,000/day free quota      | line + target | `$ai_generation` per day, all environments                |

Dashboard **Tools and actions**

| Chart                              | Type         | Data                                                                 |
| ---------------------------------- | ------------ | -------------------------------------------------------------------- |
| Tool calls per day by tool         | stacked bars | `$ai_span` by `$ai_span_name`                                        |
| Tool error and denied rate by tool | bars         | `$ai_span.$ai_is_error`, `denied`                                    |
| Tool latency p95 by tool           | bars         | `$ai_span.$ai_latency`                                               |
| Use-case mix                       | pie          | `$ai_trace.use_cases`                                                |
| Proposed action outcomes by kind   | stacked bars | `assistant_action_decided` by `kind`, `decision`                     |
| Next-step chip to turn             | bars         | `$ai_trace.next_step_kind`; `next_step_tapped` to `$ai_trace` funnel |

Dashboard **Quality**

| Chart                                   | Type         | Data                                                                                  |
| --------------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| User feedback (thumbs) over time        | line         | LLM feedback event by `rating`                                                        |
| Eval scores per run by model            | grouped bars | `eval_case_scored` mean `value` by `model`, `scorer`, `eval_run_id`                   |
| Eval pass rate by use case              | table        | `eval_case_scored` by `use_case`, `scorer`                                            |
| Online judge score on production sample | line         | PostHog evaluations on 10 % of production generations (or the nightly harness sample) |

Dashboard **Voice** (voice generations carry `voice_call`; `$ai_session_id` = utterance id)

| Chart                        | Type          | Data                                                                 |
| ---------------------------- | ------------- | -------------------------------------------------------------------- |
| Cost per utterance avg / p95 | line + target | `$ai_total_cost_usd` summed per `$ai_session_id`, per day; $0.002    |
| Voice spend per day          | bars          | `$ai_total_cost_usd` sum of voice `$ai_generation`                   |
| Utterance funnel             | funnel        | `voice_sale_started` > `voice_sale_drafted` > `voice_sale_confirmed` |
| Abandoned by stage           | bars          | `voice_sale_abandoned` by `stage`                                    |
| Engine split                 | pie           | `voice_input_used` by `engine`                                       |
| Draft latency p50 / p95      | line + target | `voice_sale_drafted.latency_ms`; 3,000 ms                            |
| STT fallback rate            | line          | `voice_sale_drafted.stt_fallback` share                              |
| Calls and cost by model      | bars          | voice `$ai_generation` by `$ai_model`, `fallback_index`              |

Dashboard **Users and stores**

| Chart                             | Type      | Data                             |
| --------------------------------- | --------- | -------------------------------- |
| Active assistant users per day    | line      | unique persons with `$ai_trace`  |
| Top users by turns                | table     | person, turns, feedback          |
| Turns per store                   | table     | `$ai_trace` by `store` group     |
| Turns per session (thread length) | histogram | `$ai_trace` per `$ai_session_id` |

Also configure: custom model pricing 0 for the free OpenRouter models, a PostHog LLM evaluation
(LLM-as-judge with the Vietnamese rubric on 10 % of production generations) if the plan offers
it, and saved LLM trace filters for errors, quota hits and rejected actions.

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
