# LLM dashboard verification

Recorded 2026-10-29 against the configured real PostHog project. Tests and
final verifications used Node 24.21.0. No credentials, project identifiers, hosts, trace IDs or message content
are included. All commands exited 0.

```sh
node --test infra/posthog/tests infra/posthog/llm/*.test.mjs
# 66 passed, 0 failed.
node infra/posthog/apply.mjs --only llm
# Summary: {"create":0,"update":18,"unchanged":10,"skip":0}
node infra/posthog/apply.mjs --only llm
# Summary: {"create":0,"update":0,"unchanged":28,"skip":0}
node infra/posthog/verify.mjs --only llm --environment test --days 7 --json
# 24 successful queries; 20 data=yes, 4 empty (allowed).
node infra/posthog/verify.mjs --only llm --environment production --days 2 --json
# 24 successful queries; 20 data=yes, 4 empty (allowed).
node infra/posthog/verify-nonsynthetic.mjs --only llm --environment test --days 7
# 24 successful queries; 19 data=yes, 5 empty (allowed).
```

The 28 objects are 4 dashboards, 21 dashboard insights covering 20 spec rows,
and 3 favorited shared trace-filter insights. Both standard verifications had
no query errors. Every row below is successful; empty rows are allowed and are
reported truthfully as data=no. Quota and online judge insights cover all
environments by design. The other rows respect their requested environment
and window. Live traffic can change these row counts.

| Dashboard         | Insight                                 | Test rows (7d) | Test data | Production rows (2d) | Production data |
| ----------------- | --------------------------------------- | -------------: | --------- | -------------------: | --------------- |
| Assistant health  | Turns per day by environment            |              3 | yes       |                    1 | yes             |
| Assistant health  | Turn latency p50 / p95                  |              3 | yes       |                    1 | yes             |
| Assistant health  | Time to first token p50 / p95 by model  |              5 | yes       |                    1 | yes             |
| Assistant health  | Model calls per turn                    |              5 | yes       |                    2 | yes             |
| Assistant health  | Error and quota rate                    |              3 | yes       |                    1 | yes             |
| Assistant health  | Fallback rate by model                  |              5 | yes       |                    1 | yes             |
| Cost and tokens   | Input / output tokens per day by model  |              7 | yes       |                    1 | yes             |
| Cost and tokens   | Tokens per turn p50 / p95               |              3 | yes       |                    1 | yes             |
| Cost and tokens   | Cost per day by model                   |              7 | yes       |                    1 | yes             |
| Cost and tokens   | Requests vs. 1,000/day free quota       |              3 | yes       |                    2 | yes             |
| Tools and actions | Tool calls per day by tool              |              9 | yes       |                    4 | yes             |
| Tools and actions | Tool error and denied rate by tool      |              3 | yes       |                    4 | yes             |
| Tools and actions | Tool latency p95 by tool                |              3 | yes       |                    4 | yes             |
| Tools and actions | Use-case mix                            |              2 | yes       |                    4 | yes             |
| Tools and actions | Proposed action outcomes by kind        |              1 | yes       |                    1 | yes             |
| Tools and actions | Next-step turns by kind                 |              0 | no        |                    1 | yes             |
| Tools and actions | Next-step chip to turn                  |              1 | yes       |                    1 | yes             |
| Quality           | User feedback (thumbs) over time        |              3 | yes       |                    1 | yes             |
| Quality           | Eval scores per run by model            |              0 | no        |                    0 | no              |
| Quality           | Eval pass rate by use case              |              0 | no        |                    0 | no              |
| Quality           | Online judge score on production sample |              1 | yes       |                    1 | yes             |
| Assistant traces  | Errors                                  |             24 | yes       |                    0 | no              |
| Assistant traces  | Quota hits                              |              8 | yes       |                    0 | no              |
| Assistant traces  | Rejected actions                        |              0 | no        |                    1 | yes             |

The model-calls histogram, per-turn token percentiles, fallback chart, error
trace filter and quota trace filter now return test data. The rejected-actions
filter has no test data: a live seven-day decision probe found 14 confirmed
test actions and no rejected test actions. The production filter does return
rejected traces. This is the remaining acceptance-data limitation; no events
were fabricated or reclassified to fill it. Test next-step attribution and eval
harness charts also remain empty. Synthetic exclusion removes the test native
next-step funnel's input evidence; it does not turn a zero-filled series into
data.

## Storage and linkage checks

The current [retention docs](https://posthog.com/docs/ai-observability/data-retention)
describe the full AI copy in `posthog.ai_events` (30 days) and the trimmed
`events` copy. An empty live SELECT resolved 25 AI columns,
including UUID, trace/session/span IDs, model/provider, tokens/costs,
latency/TTFT, error fields, input/output and tools, without retrieving content.

An initial seven-day aggregate probe found 1,697 AI rows with populated
`trace_id` in all 1,697; 1,632 had `properties.environment`, 1,346 had
`fallback_index`, 148 had `use_cases`, and 362 had `eval_run_id`.
The 65 rows without environment were online evaluation events. Custom
`denied` is retained too; AI custom properties require explicit boolean
conversion (or string comparison) rather than comparing a string with a
boolean. `next_step_kind` was absent in the initial probe, but subsequent
production verification returned data from newly arriving traffic.

The initial `events` probe returned null for direct
`properties.$ai_trace_id` on all 1,346 generations, 147 traces, 137 spans,
8 quota hits, 19 action decisions and 15 feedback events. A follow-up raw-JSON
probe found trace IDs in every sampled quota, decision and feedback event,
and in every sampled AI trace/generation. Direct lookup therefore did not
prove emitter omissions. AI queries now use the typed `trace_id` column;
non-AI linkage explicitly extracts the raw JSON ID, rejecting empty strings.
No backend changes were required.

## Query behavior and performance

Per-turn metrics aggregate one bounded AI scan by trace before histogram or
percentile calculation; explicit completed traces include zero-call turns.
The error/quota chart uses a bounded AI scan UNION ALL a bounded quota scan,
then counts unique trace IDs. There are no events×events joins. The unchanged
`scopeQuery` predicate `properties.environment` works on both tables;
regressions cover every scan of the mixed union and both template variables.
Synthetic exclusions now cover both tables, including nested scans and both
union branches, and convert the custom flag to boolean. Unsupported scan
shapes fail closed.

A timed production two-day run executed all 24 queries in 0.37–2.85 seconds
each, including network time. Model-calls took 0.52s, token percentiles 0.42s,
fallback 0.42s, the error/quota union 0.98s, and trace filters 0.38–2.85s.
No query timed out. Additional read-only live probes validated the migrated
pricing query (7.24s over 100 test generations: no missing tokens/costs or
formula mismatches) and evaluation-to-generation UUID join (1.62s); the latter
used a nonexistent evaluation ID to check schema without selecting trace data.
These are bounded observations, not a guarantee about larger future traffic.

`ai_events` retention limits these queries to available AI rows; windows
longer than 30 days cannot restore expired AI data. The native chip funnel
still uses `events` because it needs person event ordering and no moved AI
fields. Feedback and harness score events also remain on `events`.
The pricing verifier and generation selection/join helpers were migrated to
AI columns as well. Native browser-local saved filters have no REST resource;
see [the README](../README.md#llm-chart-to-insight-mapping) for the shared
saved-insight equivalent and metric definitions.

Formatting: `pnpm exec prettier --check infra/posthog` passed.
