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

## CI

Both workflows start the same local stack with `scripts/ci/eval-ci.sh`: compose Postgres and
Redis, `taphoa-seed --profile eval`, and the backend with `ASSISTANT_ALLOW_EVAL_HEADERS=1`. The
OpenRouter key (secret `OPENROUTER_API_KEY`) goes to the backend as `OPENROUTER_API_KEY` and to
the harness as `OPENROUTER_EVAL_API_KEY`.

- **Smoke job** (`assistant-eval-smoke` in `ci.yml`). Runs when `packages/eval`, the assistant,
  the seed or `ci.yml` change, and `ci-ok` waits for it. It runs live
  (`smoke --concurrency 1 --no-posthog` against the local stack) when
  `apps/backend/crates/api/src/assistant/` exists in the checkout and the secrets are available,
  that is, not on a pull request from a fork. Otherwise it runs the dry run
  (`smoke --stub`). A newer push cancels a running smoke job, which spares the shared free
  OpenRouter quota. Results are the artifact `eval-smoke-results` and the job summary. Pull
  requests send nothing to PostHog.
- **Nightly workflow** (`eval.yml`). Runs at 00:30 UTC, just after the OpenRouter quota resets,
  and on demand. A guard job skips a full run when another `eval full` run already succeeded
  or is running today (UTC), unless `force` is set, and skips the schedule until the assistant
  is on `main`. The run job builds the binaries, starts the stack, runs the set and sends the
  `eval_*` events to PostHog.
- **Manual run.** `gh workflow run eval.yml -f set=smoke`. More inputs: `-f set=full`,
  `-f model=<id>` (sent as `X-Taphoa-Eval-Model`), `-f force=true`, and
  `-f compare_models=a,b,c` (runs `compare` instead of a set).
- **Results.** The run uploads `packages/eval/results/*.md` as the artifact `eval-results` and
  appends them to the job summary. A publish job then commits them to the branch
  `eval/results` (made from `main`, or merged with `main` when it exists) and keeps one pull
  request titled `chore(eval): nightly results` open. The workflow never pushes to `main`. A
  pull request opened with `GITHUB_TOKEN` starts no CI; close and reopen it once to run the
  checks.
- **Not wired yet.** Both live paths stop at a marked placeholder step until task T7 mints the
  Clerk tokens (`EVAL_LEAD_TOKEN`, `EVAL_SELLER_TOKEN`, `EVAL_STORE_ID`) and the pg oracle
  provider exists.
