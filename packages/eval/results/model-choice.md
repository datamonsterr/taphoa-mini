# Model choice

Date: 2026-10-29 (Asia/Ho_Chi_Minh). Issue: [#58](https://github.com/datamonsterr/taphoa-mini/issues/58).

Configured assistant default: **z-ai/glm-5.3-flash**, as explicitly directed by the owner.
Last resort: **nvidia/nemotron-3.5-lightning:free**. No second paid assistant was explored
or selected after that directive. Judge: **google/gemini-2.5-flash**, distinct from both.

**Acceptance: FAIL. Issue #58 remains open; the missed bars below are not waived.**
This delivers local code and evidence for controller review. No push, PR, merge, Railway
variable change, hosted test, or PostHog configuration change was performed.

## Full run

- Run: `eval-20261028T2024-a18e`; CLI source SHA `3897af62028a`.
- Backend: `127.0.0.1:18081`, rebuilt with `packages/eval/scripts/local-stack.sh up`.
- Command: `pnpm --filter @taphoa/eval run full -- --force --concurrency 1 --no-posthog`.
- `ASSISTANT_MODELS=z-ai/glm-5.3-flash,nvidia/nemotron-3.5-lightning:free`.
- Cases: 134 scored, 10 pending, 0 not run. Pending cases remain excluded from every bar.
- [Full report](2026-10-29-z-ai-glm-5.3-flash.md), [per-case gaps and decision](2026-10-29-z-ai-glm-5.3-flash-gaps.md),
  [exact unmet oracle expectations/tools](2026-10-29-z-ai-glm-5.3-flash-gaps.json).

| Metric             | Value  | Bar     | Cases | Result |
| ------------------ | ------ | ------- | ----- | ------ |
| tool_selection     | 94.8 % | ≥ 90 %  | 134   | pass   |
| facts              | 63.1 % | ≥ 85 %  | 84    | FAIL   |
| judge              | 53.4 % | ≥ 80 %  | 133   | FAIL   |
| action             | 91.7 % | ≥ 90 %  | 12    | pass   |
| permission_leak    | 0      | 0 cases | 14    | pass   |
| injection_resisted | 100 %  | 100 %   | 7     | pass   |
| language           | 100 %  | 100 %   | 134   | pass   |
| latency_p95_ms     | 13.5 s | < 20 s  | 134   | pass   |

The earlier [full baseline](2026-10-29-z-ai-glm-5.3-flash-baseline.md) passed
latency at 12.4 s p95, but had 72% facts, 49.6% judge pass and one seller permission
leak. Its recorded source `4f9e435` was rebased to `0a13fc4`; the historical report is preserved as recorded. Fixes retained on this branch include numerical decrease normalization,
missing tool metadata, tool-required grounding recovery, focused prompts and
sampling at temperature 0. The owner-selected narrow seller guard refuses explicit
day-close/counted-cash/shortfall requests before model/tool calls, in Vietnamese
with or without diacritics and in English. Ordinary seller revenue, expense, stock
and product-sales questions remain allowed; tool permission contracts are unchanged.

The [six-case rerun](2026-10-29-z-ai-glm-5.3-flash-partial.md) verified the seller
refusal and four cases overall, p95 6.3 s. The [smoke run](2026-10-29-z-ai-glm-5.3-flash-smoke.md)
then scored facts 81.6%, judge 68%, p95 11.5 s. That smoke preceded a judge prompt
clarification: it must evaluate fixture dates without inventing a current date,
and distinguish an offer from an executed action. The judge was recalibrated
before this final full run. No golden cases, oracle values or pass bars were relaxed.

## Price and routing

The [current catalog/endpoints snapshot](2026-10-29-openrouter-catalog.json) verifies
GLM's ID, tool support and 1,048,576-token context. Catalog minimum prices are
USD **$0.0259/M input, $0.1042/M output**. The configured free last resort is also
catalog-backed and tool-capable. Only the owner-selected assistant was measured.
Source: [OpenRouter catalog](https://openrouter.ai/api/v1/models),
[GLM provider endpoints](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints).
The endpoint snapshot supplied no 30-minute latency/throughput statistics; measured
local turn latencies determine the results above.

Requests send `provider.sort="latency"`, reasoning effort `low`, temperature `0`.
Latency routing can select a provider priced above the catalog minimum; actual
usage costs, rather than catalog-token estimates, determine spend below. No paid
fallback was added without comparative evidence that it was needed.

## Judge

[Calibration](judge-calibration.md): **90% agreement, MAE 0.5**, 10 unchanged
hand-labelled items. Both required bars pass. Gemini never judges its own model.
Its catalog price is $0.30/M input and $2.50/M output. Other paid judges measured
before the fixture-context clarification are retained for review:

| Judge                                                      | Agreement | MAE | Verdict |
| ---------------------------------------------------------- | --------- | --- | ------- |
| [GPT-4.1-mini](judges/gpt-4.1-mini-calibration.md)         | 70%       | 1.0 | FAIL    |
| [GPT-5-mini](judges/gpt-5-mini-calibration.md)             | 80%       | 0.4 | FAIL    |
| [Claude Haiku 5.5](judges/claude-haiku-5.5-calibration.md) | 80%       | 0.5 | FAIL    |
| [Gemini 2.5 Flash](judge-calibration.md), final prompt     | 90%       | 0.5 | PASS    |

Judge reasons in the gaps report are model assessments; factual scoring remains
independent SQL-oracle scoring. Any unjudged cases are explicitly listed in the
full report and do not constitute passing judge evidence.

## Usage and budget

- Usage-accounted turns: **142**, including policy refusals at zero.
- Mean cost per turn: **$0.00102023**.
- p95 cost per turn: **$0.00228595** (nearest rank).
- Full-run assistant usage: **$0.14487256** across all generations.
- Task spend by eval-key usage delta: **$0.557549496** from initial
  usage $0.394561591 to final usage **$0.952111087**.
- Key limit remains **$6.50**; remaining credit **$5.547888913**.
  No key limit was raised in this resumed run. The cumulative key usage, including
  pre-task charges, also remains below the hard task cap.
- [Spend checkpoints](2026-10-29-spend.json), [usage reconciliation](2026-10-29-z-ai-glm-5.3-flash-accounting.json).

Key snapshots include judge charges, earlier calibration/smoke/partial/full runs,
and failed/cancelled calls; account usage can lag individual responses. They are
not isolated per-run invoices. The cost-per-turn figures are actual assistant
SSE usage, exclude judge charges, and include all tool-loop calls. OpenRouter
[usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
is automatic in the final streaming chunk; deprecated `usage.include` is not used.
Paid missing costs remain unknown; `:free` generations explicitly report zero.
PostHog verification uses catalog/provider price bounds with 10% + $1e-8 tolerance.
The local generation-event capture is partial because the prior listener process
had exited; it was restored during the full run. Full turn usage comes separately
from captured SSE completions. No remote pricing or online-judge apply was run.

## Validation

All Cargo commands, including commit hooks, use
`CARGO_TARGET_DIR=/media/storage/cache/i58p-target RUSTC_WRAPPER=env`. No `cargo clean`.

| Check                                                                     | Result                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `cargo test -p taphoa-api`                                                | 406 passed; 6 lib tests ignored; DB suites separately below |
| loop + telemetry + sales-tool tests, `--include-ignored --test-threads=1` | 44 passed (29 + 4 + 11), dedicated local test DB            |
| `cargo clippy -p taphoa-api --all-targets -- -D warnings`                 | pass                                                        |
| `cargo fmt --all --check`                                                 | pass                                                        |
| `pnpm --filter @taphoa/eval test`                                         | 668 passed                                                  |
| eval typecheck                                                            | pass                                                        |
| eval SQL-oracle integration                                               | 256 passed                                                  |
| `node --test infra/posthog/tests infra/posthog/llm/*.test.mjs`            | 68 passed                                                   |
| `python3 -m pytest scripts/ci`                                            | 68 passed                                                   |
| API client tests/typecheck/generated check                                | 40 passed; types and generated schema current               |
| `pnpm lint:api`                                                           | pass, 6 existing warnings                                   |
| Prettier + commitlint hooks                                               | pass                                                        |

Node is 26.12.0 (repository engine requests Node 24); no Node 24 run is claimed.
The narrow guard additions were observed failing before implementation, then passed.
Paid accounting, missing fields, zero-cost free policy, quota independence and
price tolerances have unit coverage. Nightly/CI retains the free guard for free
overrides and uses remaining USD credits for the paid primary.

## Exact controller values

Set on the Railway backend in **test and production** when the controller approves
this rollout; this task did not change those environments:

```dotenv
ASSISTANT_MODEL_PROVIDER=openrouter
ASSISTANT_MODELS=z-ai/glm-5.3-flash,nvidia/nemotron-3.5-lightning:free
ASSISTANT_REASONING_EFFORT=low
```

Keep `ASSISTANT_ALLOW_EVAL_HEADERS=1` only on test and `0`/unset in production.
For the eval runner (CI/nightly or local):

```dotenv
EVAL_JUDGE_MODELS=google/gemini-2.5-flash
```

Keep each environment's existing secret key value; ensure it has a suitable finite
credit limit. The eval key remains capped at $6.50. Worktree and task-owned build
cache are retained because the branch is unmerged; no cleanup of other worktrees.
