# @taphoa/eval

Evaluation harness for the assistant (epic X7). It holds the golden set of
Vietnamese and English cases, the scorers, the oracle queries, and the runner
that drives `@taphoa/api-client` against the assistant.

Plan: `docs/specs/assistant/x7-plan.md`. Spec: `docs/specs/assistant/golden-set.md`.

## Commands

Run them with `pnpm --filter @taphoa/eval run <command> -- <options>`, or
`node src/cli.ts <command>` from this package.

| Command                        | What it does                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `validate [--dir golden]`      | Check the golden cases and their coverage.                                                   |
| `smoke`                        | Run the 25 smoke cases against a backend and write `results/<date>-<model>-smoke.md`.        |
| `full`                         | Run every case; one per day unless `--force`. Writes `results/<date>-<model>.md`.            |
| `compare --models a,b,c`       | Run the smoke set once per model, rank them, write `results/model-choice.md`.                |
| `calibrate [--judge-model id]` | Check the judge against `src/judge/calibration.jsonl`, write `results/judge-calibration.md`. |

`smoke`, `full` and `compare` options: `--stub` or `--bad-stub` (dry run, below),
`--model <id>` (smoke, full), `--ids a,b` and `--tags t` (smoke, full; the run is then
`partial` and never counts as the day's full run), `--concurrency n` (default 1),
`--force`, `--posthog` / `--no-posthog`, `--no-judge`, `--backend URL`, `--dir golden-dir`,
`--out results-dir`.

Exit codes: 0 every bar passed, 1 a bar was missed or the run was refused or aborted (free
quota too low, a full run already today, a `quota` error from the assistant), 2 bad usage or
configuration.

## Dry run

`smoke --stub` starts the stub assistant in this process (`src/runner/stub-assistant.ts`)
with a script that answers every case correctly, a fake oracle and a fake judge. It needs no
backend, database or key, skips the quota check and sends no PostHog events. It exits 0 when
the bars pass. `--bad-stub` uses a script that fails on purpose and must exit 1. Without
`--out`, a dry run writes its results file to a fresh temp directory.

While `golden/` holds no cases, a dry run uses `src/runner/fixtures/cases.jsonl`.

## Live runs

Environment (values are never printed):

| Variable                                | Use                                                 |
| --------------------------------------- | --------------------------------------------------- |
| `BACKEND_URL`                           | Backend to test (or `--backend`).                   |
| `EVAL_LEAD_TOKEN`, `EVAL_SELLER_TOKEN`  | Bearer tokens of the two members of the eval store. |
| `EVAL_STORE_ID`                         | Optional, sent as `X-Store-Id`.                     |
| `EVAL_DATABASE_URL`                     | Database the oracle SQL reads (task T3).            |
| `OPENROUTER_EVAL_API_KEY`               | Quota guard and judge.                              |
| `EVAL_JUDGE_MODELS`                     | Ordered judge models (default two free models).     |
| `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` | Where `eval_*` events go (host default US cloud).   |
| `EVAL_TODAY`                            | Business date to pin (default `2026-10-20`).        |

The backend must run with `ASSISTANT_ALLOW_EVAL_HEADERS=1`. The runner sends
`X-Taphoa-Eval-Run` and `X-Taphoa-Today` on every request, and `X-Taphoa-Eval-Model` when
`--model` is set.

Live runs need the pg oracle provider. Until task T3 adds it, `src/oracle/live.ts`
(`createLiveOracle`) refuses with a message naming `EVAL_DATABASE_URL`. Clerk-minted tokens
(task T7) plug into `CachedAuth` in `src/runner/auth.ts`.
