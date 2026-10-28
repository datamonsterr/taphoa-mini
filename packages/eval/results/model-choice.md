# Model choice

Date: 2026-10-29 (Asia/Ho_Chi_Minh). Issue: [#58](https://github.com/datamonsterr/taphoa-mini/issues/58).

The owner-selected assistant remains **z-ai/glm-5.3-flash**. The existing last resort
remains **nvidia/nemotron-3.5-lightning:free**; every generation in this full run used
GLM. Judge: **google/gemini-2.5-flash**, unchanged and previously calibrated at
90% agreement / MAE 0.5 ([calibration](judge-calibration.md)).

**Acceptance: FAIL. Issue #58 and PR #126 remain open. No bars, rubrics, golden
cases or judge settings were changed. No push, merge or deployment was performed.**

## Latest full run

- Run: `eval-20261028T2113-1bbd`; committed source `4a5767a7d066` (prompt v7).
- Local stack rebuilt and reseeded with `packages/eval/scripts/local-stack.sh up`.
- Command: `pnpm --filter @taphoa/eval run full -- --force --concurrency 1 --no-posthog`.
- Models: `ASSISTANT_MODELS=z-ai/glm-5.3-flash,nvidia/nemotron-3.5-lightning:free`;
  `EVAL_JUDGE_MODELS=google/gemini-2.5-flash`.
- 134 scored cases, 10 pending, zero not run; all 134 were judged.
- [Full report](2026-10-29-z-ai-glm-5.3-flash.md),
  [remaining gaps](2026-10-29-z-ai-glm-5.3-flash-gaps.md),
  [per-case evidence](2026-10-29-z-ai-glm-5.3-flash-gaps.json).

| Metric             | Prior full run | Latest | Bar     | Result |
| ------------------ | -------------- | ------ | ------- | ------ |
| tool_selection     | 94.8%          | 98.5%  | ≥90%    | pass   |
| facts              | 63.1%          | 92.3%  | ≥85%    | pass   |
| judge              | 53.4%          | 61.9%  | ≥80%    | FAIL   |
| action             | 91.7%          | 91.7%  | ≥90%    | pass   |
| permission_leak    | 0              | 0      | 0 cases | pass   |
| injection_resisted | 100%           | 100%   | 100%    | pass   |
| language           | 100%           | 99.3%  | 100%    | FAIL   |
| latency p95        | 13.5 s         | 13.6 s | <20 s   | pass   |

Prior full run: `eval-20261028T2024-a18e`. No second final full run was made: the
judge remains 18.1 percentage points below its bar, so the result is not close.
Budget was available; the owner's condition for a second full run was not met.
There is no Railway/hosted acceptance or deployment proof in this continuation.

## Changes and targeted evidence

The [grounding investigation](2026-10-29-z-ai-glm-5.3-flash-grounding.md) and
[captured drafts/tool data](2026-10-29-z-ai-glm-5.3-flash-grounding.json) cover all
22 historical fallback cases and four additional missing-data cases. The baseline
rerun had no omitted tool messages; its maximum tool input was 10,574 characters
against the 24,000-character budget. Six historical symptoms did not recur and
are explicitly unconfirmed, rather than claimed fixed.

V7 adds tested normalization for cash deductions, loss percentages, calendar ranges,
matcher probabilities and a same-member manual-lines/sales ratio. Read tools now
provide stored-cost fallbacks, named margin queries, receipt supplier/candidates,
review price differences, recognition confusion pairs, supplier counts/premiums,
utility totals and forecast category/aggregate data. Prompts emphasize focused
answers, unexecuted proposal drafts, permission refusals, available help content,
current-turn evidence and the intended tools.

- [26-case baseline](2026-10-29-z-ai-glm-5.3-flash-grounding-baseline.md): facts 34.8%, judge 23.1%.
- [39-case v7 iteration](2026-10-29-z-ai-glm-5.3-flash-v7-priority.md): tools 97.4%, facts 70.4%, judge 53.8%.
- [Eight-case follow-up](2026-10-29-z-ai-glm-5.3-flash-v7-verify.md): exposed the final probability/ratio regressions, then fixed with failing-before/passing-after unit tests.

Targeted reports record their starting HEAD while v7 was still being edited. The
full run above used the committed final source, with no compilation during it.
Sampling remains temperature 0, reasoning `low`, provider sorting by latency.

## Remaining work and decisions

There are 51 judge misses. Many remain real relevance, completeness, refusal or
proposal-answer issues; judge scores are preserved. U15-03 also has a reviewable
judge mismatch: it demands a spelled-out answer amount although the rubric asks
to understand the transcribed amount and explicitly supplies 95.000 dong.

Five final answers still hit the grounding fallback; exact drafts, tool payloads
and unmatched values are in the gaps JSON:

- U7-02 / U7-06: inclusive 60-day interval is reported as 59 by tool metadata.
- U16-06: parenthesized `9/2026` is parsed as a claim of 2026.
- U17-03: valid latest-supplier difference and percentage lack explicit derived evidence.
- U18-02: valid Friday–Sunday subtotal lacks evidence; only Saturday/Sunday is summarized.

The full run also omitted tool messages in U18-01 / U18-04, including a current
forecast. Forecast arrays and combined results need a compact representation that
preserves totals and requested daily detail. This is distinct from the priority
baseline, which had no omissions; raising the budget globally is not yet justified.

Other remaining misses: tool routing U10-03 / U21-06; action U14-03; facts for
U20-02 / U21-01 / U21-06. The help library lacks some U12-02/04/05 flows expected
by the unchanged cases; current app code has no sale-history/void screen or invite
role selector. Do not invent those instructions.

U4-03 is the only language miss: its answer is English and the judge awarded 5/5,
but required Vietnamese product names trip the heuristic's Vietnamese-letter limit.
The failed language score remains unchanged pending scorer review.

Keep #58 open, retain both fixed models and keep all bars/cases unchanged. The ten
pending digest/debt cases remain excluded from every bar.

## Usage and budget

- 142 completed turns with complete input/output/total cost components.
- Mean assistant cost/turn: **$0.00094853**; p95: **$0.00183826**.
- Assistant usage: **$0.134691026**; judge usage: **$0.045737400**.
- 302 paid GLM generations, zero missing cost fields, component mismatches or
  provider-price-bound mismatches. All 142 turn captures reconcile with SSE usage.
- Settled full-run usage: **$0.180428426**. Key usage rose from $1.098763685 to
  **$1.279192111** after delayed accounting settled.
- This continuation: **$0.327081024**, from starting key usage $0.952111087.
- Hard key limit remains **$6.50**; remaining credit **$5.220807889**.
  Remaining before the owner's $6.00 stop line: **$4.720807889**. No cap was raised.

[Spend checkpoints](2026-10-29-spend.json),
[usage reconciliation](2026-10-29-z-ai-glm-5.3-flash-accounting.json).
Key snapshots include assistant/judge charges and can lag responses. The settled
snapshot reconciles exactly with the full run's assistant plus judge usage. The
[OpenRouter catalog/endpoints snapshot](2026-10-29-openrouter-catalog.json) supplies
price bounds; actual streaming usage determines costs, not minimum catalog prices.
No remote PostHog pricing or online-judge configuration was applied.

## Validation

Cargo used the requested target directory and `RUSTC_WRAPPER=env`; no `cargo clean`.

| Check                                                          | Result                                                |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| `cargo test -p taphoa-api`                                     | pass; 411 library tests, 6 library tests ignored      |
| DB-backed loop / telemetry / tool suites                       | 62 passed (30 + 4 + 16 + 12); latest tool tests 28/28 |
| `cargo clippy -p taphoa-api --all-targets -- -D warnings`      | pass                                                  |
| `cargo fmt --all --check`                                      | pass                                                  |
| `pnpm --filter @taphoa/eval test`                              | 668 passed                                            |
| eval typecheck                                                 | pass                                                  |
| `node --test infra/posthog/tests infra/posthog/llm/*.test.mjs` | 68 passed                                             |
| Prettier and Conventional Commit hooks                         | pass                                                  |

The final two guard additions have current unit/full Cargo coverage; the database
loop/telemetry run preceded those pure normalization additions. The latest database
tool run covers the final SQL and payload changes. Node is 26.12.0; the repository
requests Node 24, and no Node 24 validation is claimed. The unmerged worktree and
build cache are retained; no push or cleanup of other worktrees.
