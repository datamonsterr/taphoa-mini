# Model choice

Date: 2026-10-29 (Asia/Ho_Chi_Minh). Issue: [#58](https://github.com/datamonsterr/taphoa-mini/issues/58), PR #126.

Assistant remains **z-ai/glm-5.3-flash**, with the existing
**nvidia/nemotron-3.5-lightning:free** last resort. All 294 generations in this full
run used GLM. Judge remains **google/gemini-2.5-flash**. No cases, rubrics,
calibration labels, pass scores or acceptance bars changed.

**Local eval acceptance: PASS.** Implementation commit: `c9447021d113` (prompt v8).
No push, merge or deployment was performed. PR #126 remains unmerged; this worktree
and its Cargo cache are retained.

## Full run

- Run: `eval-20261028T2154-c1e8`, 134 cases run, 10 pending, zero not run.
- Local stack rebuilt and reseeded with `packages/eval/scripts/local-stack.sh up`.
- Command: `pnpm --filter @taphoa/eval run full -- --force --concurrency 1 --no-posthog`.
- [Full report](2026-10-29-z-ai-glm-5.3-flash.md),
  [remaining gaps](2026-10-29-z-ai-glm-5.3-flash-gaps.md),
  [case evidence](2026-10-29-z-ai-glm-5.3-flash-gaps.json),
  [cost accounting](2026-10-29-z-ai-glm-5.3-flash-accounting.json).

| Metric             | Baseline v7 | Latest v8 | Bar     | Result |
| ------------------ | ----------- | --------- | ------- | ------ |
| tool_selection     | 98.5%       | 99.3%     | ≥90%    | pass   |
| facts              | 92.3%       | 92.5%     | ≥85%    | pass   |
| judge              | 61.9%       | 86.5%     | ≥80%    | pass   |
| action             | 91.7%       | 91.7%     | ≥90%    | pass   |
| permission_leak    | 0           | 0         | 0 cases | pass   |
| injection_resisted | 100%        | 100%      | 100%    | pass   |
| language           | 99.3%       | 100%      | 100%    | pass   |
| latency p95        | 13.6 s      | 11.3 s    | <20 s   | pass   |

Baseline: `eval-20261028T2113-1bbd`, preserved in git at `f75ea5c`.
The judge comparison includes both improved assistant answers and fairer judge
context; it is not an isolated model-quality experiment.

There were **115 passes among 133 judged cases**, plus **one unjudged case**:
U4-01 returned HTTP400 from the judge. The unchanged harness excludes it from the
judge denominator and reports PASS. Even counting that case as a failure gives
115/134 = **85.8%**, still above the 80% bar. An identical-input diagnostic replay
returned HTTP200 and score5; it is excluded from the full-run scores. No result
was silently replaced. All 134 answers passed language detection.

No second full run was made because every requested bar was met. There is no
hosted/Railway acceptance or deployment proof in this continuation.

## Changes and judge validity

The [51-failure cluster analysis](2026-10-29-z-ai-glm-5.3-flash-judge-clusters.md)
assigns every original judge miss to a primary cluster and records the fix choice.
General report guidance supplies supplier grouping/last costs, tied-up capital,
forecast attribution, receipt-review structure and unexecuted proposal wording.
Read tools now supply effective product thresholds, actual member permissions,
receipt line numbers/unit costs, latest-supplier comparisons and a Friday-through-
Sunday forecast subtotal. Repeated forecast dates and holiday factors are sent
once in a shared calendar, retaining aligned daily quantities.

The judge previously received only a rubric and final answer despite the earlier
fixture-time warning. It now receives the user-message history, pinned business
date, role, requested language, proposed actions, SQL assertions and actual final-
turn tool results from the eval database, scoped by store and thread. Partial
oracle assertions alone proved insufficient: the first diagnostic iteration
mistook valid extra tool values for inventions. Full tool evidence resolves that
missing context. No golden answers enter the assistant prompt.

The final input format passed [Gemini calibration](judge-calibration.md):
**90% agreement, MAE 0.6**, against unchanged bars of ≥90% / ≤0.8. Two intermediate
context-instruction variants failed at 70% / 1.0 and were discarded. The accepted
concise format uses the same serializer in calibration and live eval. Original
calibration examples contain no user history or tool payloads, so those missing
fields are not fabricated; the report states this limitation.

English detection removes only exact entity names from resolved SQL facts before
applying the existing heuristic. Unit tests accept English prose with Vietnamese
product names and still reject Vietnamese prose, mixed wrong-language prose,
name-only answers and English answers when Vietnamese is required. The targeted
U4-03 answer retained Vietnamese names and passed; its full-run answer later hit a
separate English-date grounding fallback, which is retained in the gaps.

## Targeted evidence and remaining work

- [36-case context diagnostic](2026-10-29-z-ai-glm-5.3-flash-v8-context-diagnostic.md):
  tools100%, facts96%, judge55.6%, language100%, p9510.6s. This intermediate format
  had only partial oracle assertions; its judge misses are diagnostic, not final.
- [12-case verification](2026-10-29-z-ai-glm-5.3-flash-v8-verify.md): tools100%,
  facts95%, judge91.7%, language100%. A 23.3-second recognition turn missed that
  small sample's latency bar; the final full run's p95 is 11.3 seconds.
- The setup checklist was then corrected to keep thresholds incomplete when
  per-product thresholds are missing, even if a store default is configured.

There are **18 judge misses**, one unjudged case, and **21 cases with any recorded
gap**. Seven final answers are grounding fallbacks. Captures distinguish real
unrequested/unsupported numbers (including a retry that turns 8 missing products
into 28) from parser failures for English dates, standalone months and percentage
ranges. Remaining answer issues include incomplete proposal/file summaries,
owner-only refusal wording, catalogue suggestions and tax-help routing.

U12-02/04/05 require help flows absent from the embedded articles or current UI;
unsupported barcode/manual-grid, sale-history/void and invite-role-selector steps
were not invented. U14-03 proposes the right receipt line and quantity under
`new_values.quantity`, while the unchanged case expects top-level `quantity`.
The scorer and public payload were not modified to hide that mismatch. The ten
pending digest/debt cases remain excluded from the bars.

## Usage and validation

- Full assistant usage: **$0.141183074**, reconciled across all 142 completed turns
  and 294 GLM generations. All cost components are present and sum correctly.
- Full judge usage with reported accounting: **$0.114730200**. The diagnostic
  HTTP replay cost **$0.000763700** and is separate from the full score.
- Mean assistant cost/turn: **$0.00099425**; p95: **$0.00179164**.
- Latest observed key usage: **$1.674439329 / $6.50**; this continuation spent
  **$0.395247218** from $1.279192111. Headroom to the **$6.00 stop is $4.325560671**.
  The settled full-run key delta, including the separate HTTP replay, is
  $0.256676974 and reconciles with the reported assistant and judge costs.
- Full local captures contain **zero omitted tool messages**, with at most
  18,286 tool-content characters in a generation input. The character budget was
  not increased. Backend telemetry for the full run was captured locally; the
  runner used `--no-posthog`.

Rust workspace tests, all API library tests including ignored database checks,
focused database-backed ops/sales/loop/action/tool suites, Clippy with warnings
denied, fmt, 670 eval tests/typecheck, 80 PostHog tests, Prettier and commitlint
pass. See [validation evidence](2026-10-29-z-ai-glm-5.3-flash-validation.md) for exact
commands, counts and intentionally unrun checks. `CARGO_TARGET_DIR` stayed
`/media/storage/cache/i58p-target` with `RUSTC_WRAPPER=env`; no `cargo clean` ran.
