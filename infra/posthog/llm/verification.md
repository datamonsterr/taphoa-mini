# LLM dashboard verification

Recorded 2026-10-28 against the configured real PostHog project. No credentials,
project identifiers, hosts or user/message content are included in this report.

```sh
node infra/posthog/apply.mjs --only llm
# Summary: {"create":28,"update":0,"unchanged":0,"skip":0}
node infra/posthog/apply.mjs --only llm
# Summary: {"create":0,"update":0,"unchanged":28,"skip":0}
node infra/posthog/verify.mjs --only llm --environment test --days 30
# Exit 0; all 24 queries succeeded. Empty LLM insights are allowed.
```

The 28 objects are 4 dashboards, 21 dashboard insights covering 20 spec rows,
and 3 favorited shared trace-filter insights. Native browser-local saved filters
have no REST resource; see [the README](../README.md#llm-chart-to-insight-mapping)
for the API-supported saved-insight equivalent and metric definitions.

Verification returned data for **15** insights; **9** were empty.
The quota insight intentionally includes all environments. Every other row is
scoped to `test` and a 30-day lookback.

| Dashboard         | Insight suffix                          | Rows | Data | Query                           |
| ----------------- | --------------------------------------- | ---: | ---- | ------------------------------- |
| Assistant health  | Turns per day by environment            |    2 | yes  | ok                              |
| Assistant health  | Turn latency p50 / p95                  |    2 | yes  | ok                              |
| Assistant health  | Time to first token p50 / p95 by model  |    2 | yes  | ok                              |
| Assistant health  | Model calls per turn                    |    0 | no   | ok; empty allowed               |
| Assistant health  | Error and quota rate                    |    2 | yes  | ok                              |
| Assistant health  | Fallback rate by model                  |    1 | yes  | ok                              |
| Cost and tokens   | Input / output tokens per day by model  |    2 | yes  | ok                              |
| Cost and tokens   | Tokens per turn p50 / p95               |    0 | no   | ok; empty allowed               |
| Cost and tokens   | Cost per day by model                   |    2 | yes  | ok                              |
| Cost and tokens   | Requests vs. 1,000/day free quota       |    2 | yes  | ok                              |
| Tools and actions | Tool calls per day by tool              |    6 | yes  | ok                              |
| Tools and actions | Tool error and denied rate by tool      |    3 | yes  | ok                              |
| Tools and actions | Tool latency p95 by tool                |    3 | yes  | ok                              |
| Tools and actions | Use-case mix                            |    2 | yes  | ok                              |
| Tools and actions | Proposed action outcomes by kind        |    1 | yes  | ok                              |
| Tools and actions | Next-step turns by kind                 |    0 | no   | ok; empty allowed               |
| Tools and actions | Next-step chip to turn                  |    1 | yes  | ok                              |
| Quality           | User feedback (thumbs) over time        |    2 | yes  | ok                              |
| Quality           | Eval scores per run by model            |    0 | no   | ok; empty allowed               |
| Quality           | Eval pass rate by use case              |    0 | no   | ok; empty allowed               |
| Quality           | Online judge score on production sample | data | yes  | ok ($ai_evaluation, 2026-10-28) |
| Assistant traces  | Errors                                  |    0 | no   | ok; empty allowed               |
| Assistant traces  | Quota hits                              |    0 | no   | ok; empty allowed               |
| Assistant traces  | Rejected actions                        |    0 | no   | ok; empty allowed               |

A property-completeness check of existing test events found 28 `$ai_trace`,
52 `$ai_generation`, 19 `$ai_span` and 6 `assistant_action_decided` events;
none had `$ai_trace_id`. Those events also had no `next_step_kind`. The current
backend emitter already sends those properties, so no backend change was made.
New traffic is needed to populate trace-grouped charts and saved trace filters.

The backend property names agree with the telemetry contract. The dashboard
spec's unnamed feedback event is resolved to `assistant_feedback_submitted`,
not the optional survey mirror or mobile feedback event. `use_cases` is an array,
tool span names have the `tool:` prefix, and latency/TTFT units follow the emitter.
Exact chip-level funnel attribution would need a shared chip id on mobile tap
and backend trace events; the current chart is ordered aggregate conversion.
Eval harness data has `environment=eval`; the judge chart uses the specified
nightly harness alternative and does not provision online judging (#63).

Local validation on Node 24.21.0:

- `node --test infra/posthog/tests`: 30 passed, 0 failed.
- `node infra/posthog/apply.mjs --dry-run --offline`: passed; 77 creates,
  1 settings update, 1 skipped group, no network or credentials.
- `pnpm exec prettier --check infra/posthog`: passed.
