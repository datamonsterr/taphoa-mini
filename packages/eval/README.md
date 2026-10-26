# @taphoa/eval

Evaluation harness for the assistant (epic X7). It holds the golden set of
Vietnamese and English cases, the scorers, the oracle queries, and the runner
that drives `@taphoa/api-client` against the assistant.

Plan: `docs/specs/assistant/x7-plan.md`. Spec: `docs/specs/assistant/golden-set.md`.

## Commands

Run them with `pnpm --filter @taphoa/eval run <command> -- <options>`, or
`node src/cli.ts <command>` from this package.

| Command                        | What it does                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `validate [--dir golden]`      | Check the golden cases, their coverage and that every oracle name exists.                                                 |
| `oracles [--md] [--out f]`     | Run every oracle against `EVAL_DATABASE_URL` and print the values; `--md` writes `ORACLES.md`.                            |
| `smoke`                        | Run the 25 smoke cases against a backend and write `results/<date>-<model>-smoke.md`.                                     |
| `full`                         | Run every case; one per day unless `--force`. Writes `results/<date>-<model>.md`.                                         |
| `compare --models a,b,c`       | Run the smoke set once per model, rank them, write `results/model-choice.md`.                                             |
| `calibrate [--judge-model id]` | Check the judge against `src/judge/calibration.jsonl`, write `results/judge-calibration.md`.                              |
| `identities [--github-env]`    | Mint a Clerk token for the lead and the seller (pre-flight); `--github-env` masks them and appends them to `$GITHUB_ENV`. |

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

| Variable                                | Use                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `BACKEND_URL`                           | Backend to test (or `--backend`).                                                                         |
| `EVAL_LEAD_TOKEN`, `EVAL_SELLER_TOKEN`  | Bearer tokens of the two members of the eval store (fixed tokens win over `CLERK_SECRET_KEY`).            |
| `CLERK_SECRET_KEY`, `CLERK_API_URL`     | Mint the tokens during the run (`ClerkAuth`, below); `CLERK_API_URL` defaults to `https://api.clerk.com`. |
| `EVAL_STORE_ID`                         | Optional: `X-Store-Id`, and the store the oracles read (default `e7a10e7a-0000-4000-8000-000000000000`).  |
| `EVAL_DATABASE_URL`                     | Database the oracle SQL reads (the seeded eval store).                                                    |
| `OPENROUTER_EVAL_API_KEY`               | Quota guard and judge.                                                                                    |
| `EVAL_JUDGE_MODELS`                     | Ordered judge models (default two free models).                                                           |
| `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` | Where `eval_*` events go (host default US cloud).                                                         |
| `EVAL_TODAY`                            | Business date to pin (default `2026-10-20`).                                                              |

The backend must run with `ASSISTANT_ALLOW_EVAL_HEADERS=1`. The runner sends
`X-Taphoa-Eval-Run` and `X-Taphoa-Today` on every request, and `X-Taphoa-Eval-Model` when
`--model` is set.

Live runs need the pg oracle provider (`src/oracle/live.ts`, `createLiveOracle`); without
`EVAL_DATABASE_URL` they stop with a message naming it.

### Identity: `ClerkAuth`

With `CLERK_SECRET_KEY` set and no `EVAL_LEAD_TOKEN`, the CLI uses `ClerkAuth`
(`src/runner/auth.ts`). Fixed tokens (`EnvAuth`) still win when `EVAL_LEAD_TOKEN` is set.
`ClerkAuth` works against a Clerk development instance:

1. It finds each role's user by email (`GET /v1/users?email_address=`). The eval seed creates
   them (epic X1, `seed::clerk::member_email` with store key `eval`, sign-in code 424242):
   `seed-eval-co-ba+clerk_test@example.com` (lead, Cô Ba) and
   `seed-eval-be-na+clerk_test@example.com` (seller, Bé Na). A missing user stops the run with
   the email in the message.
2. It creates a session (`POST /v1/sessions`, development instances only) and mints a token
   (`POST /v1/sessions/{id}/tokens`, 60 s).
3. Tokens are cached per role and refreshed 10 s before they expire. The Backend API budget is
   100 requests per 10 s for everyone, so requests run one at a time and a 429 waits for
   `Retry-After`. Errors show a status, never a body or the key.
4. Every request carries `X-Store-Id: $EVAL_STORE_ID` (default `e7a10e7a-0000-4000-8000-000000000000`).

`node src/cli.ts identities` mints one token per role and prints no token: a pre-flight check
for CI and for you. `identities --github-env` also appends masked `EVAL_LEAD_TOKEN`,
`EVAL_SELLER_TOKEN` and `EVAL_STORE_ID` to `$GITHUB_ENV`. Do not export those to a long run:
the tokens last about 60 s. Pass `CLERK_SECRET_KEY` instead.

Until epic X1 is on `main`, the seed creates no Clerk users and `identities` fails with the
missing email. `X1-SEED-PATCH.md` describes the seed change that makes them.

## Local stack

`scripts/local-stack.sh` brings up a throwaway stack on your machine for live runs: the eval
store in a database of the shared dev Postgres (`docker compose up -d` provides Postgres on
55432 and Redis on 56379), and a backend with `ASSISTANT_ALLOW_EVAL_HEADERS=1` and the real
OpenRouter provider (`ASSISTANT_MODEL_PROVIDER=openrouter`, `ASSISTANT_MODELS` from
`.env.example`, Redis logical database 7).

```sh
packages/eval/scripts/local-stack.sh up       # build, create db, seed --reset, start, wait for /readyz
packages/eval/scripts/local-stack.sh status
packages/eval/scripts/local-stack.sh env      # print the exports again
packages/eval/scripts/local-stack.sh down     # stop the backend, drop the db, flush Redis db 7
```

`up` reads `OPENROUTER_EVAL_API_KEY`, `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` from
`~/.config/taphoa-mini/secrets.env` (override: `EVAL_SECRETS_FILE`; variables already set win)
and never prints them. The backend gets the OpenRouter key as `OPENROUTER_API_KEY`. It prints
the exports to source:

```sh
export BACKEND_URL=http://127.0.0.1:18080
export EVAL_DATABASE_URL=postgres://taphoa:taphoa@localhost:55432/taphoa_eval_local
export EVAL_STORE_ID=e7a10e7a-0000-4000-8000-000000000000
```

Then load the secrets for the harness (`set -a; source ~/.config/taphoa-mini/secrets.env; set +a`
in bash or zsh) and run `pnpm --filter @taphoa/eval run smoke -- --concurrency 1`. Live runs
spend the OpenRouter free quota; `smoke --stub` does not.

Options (environment): `EVAL_STACK_PG_URL`, `EVAL_STACK_DB` (default `taphoa_eval_local`),
`EVAL_STACK_REDIS_URL` (default `redis://localhost:56379/7`; `up` and `down` flush that
database, so keep it to this stack), `EVAL_BACKEND_PORT` (default: first free from 18080),
`EVAL_STACK_STATE_DIR` (pid and logs), `EVAL_STACK_KEEP_DB=1`, and `CARGO_TARGET_DIR` for the
build output. The script needs `cargo`, `node` (with this package's dependencies installed)
and `curl`, not `psql` or `redis-cli`. It shares its seed, start and readiness steps with CI
(`scripts/ci/eval-stack-lib.sh`).

## CI

Both workflows start the same stack with `scripts/ci/eval-ci.sh`: compose Postgres and
Redis, `taphoa-seed --profile eval`, and the backend with `ASSISTANT_ALLOW_EVAL_HEADERS=1`. The
OpenRouter key (secret `OPENROUTER_API_KEY`) goes to the backend as `OPENROUTER_API_KEY` and to
the harness as `OPENROUTER_EVAL_API_KEY`.

- **Smoke job** (`assistant-eval-smoke` in `ci.yml`). Runs when `packages/eval`, the assistant,
  the seed, the migrations or `ci.yml` change, and `ci-ok` waits for it. It runs live
  (`smoke --concurrency 1 --no-posthog` against the local stack) when
  `apps/backend/crates/api/src/assistant/` and `members.clerk_user_id` exist in the checkout
  and the secrets are available, that is, not on a pull request from a fork. Otherwise it runs the dry run
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
- **Identity.** The live path needs Clerk identity (epic X1) in the checkout:
  `scripts/ci/eval-ci.sh mode` picks live only when the assistant exists and a migration adds
  `members.clerk_user_id`, and the nightly schedule waits for the same. Before X1 merges, CI runs
  the stub dry run and stays green; afterwards it goes live without another change. A live job
  runs `identities` as a pre-flight, then gives `CLERK_SECRET_KEY` to the run step, where
  `ClerkAuth` mints and refreshes the 60 s tokens.

Live runs read expected values from `EVAL_DATABASE_URL` through the pg oracle provider
(`src/oracle/live.ts`, `createLiveOracle`); without it they stop with a message naming the
variable.

## Oracles

Expected facts are computed by SQL, never typed. `src/oracle/queries/<name>.sql` holds one
oracle per file; `ORACLES.md` lists them for case writers (name, kind, args, description,
example args, sample value, refs, period names). It is generated: after a change to a query,
run `node src/cli.ts oracles --md` against the seeded database and commit the result.

A query opens with a header:

```sql
-- oracle: sales_revenue
-- kind: money            (names | number | money | percent | count)
-- args: period period    (optional: "<name> <type>, ...")
-- uses: U2, U10, U22     (use cases; PERM for permission facts)
-- describe: Revenue of completed sales in a period, in dong.
-- example: {"period":"yesterday"}   (required with args)
```

`$1` is the store id, `$2` the business date `today`, declared args follow from `$3` in
header order (a `period` takes two placeholders: its first and last date). Every placeholder
must appear in the SQL, so each query starts with a `ctx` CTE that names them. Names of
products keep a display form: the injection product loses its injected tail.

## Integration tests

`pnpm test:integration` runs the tests that need a database (`src/**/*.integration.test.ts`);
they are not part of `pnpm test`. They skip without `EVAL_DATABASE_URL`. To run them:

```sh
createdb taphoa_eval   # or any empty database
DATABASE_URL=postgres://.../taphoa_eval cargo run -p taphoa-api --bin taphoa-seed -- --profile eval
EVAL_DATABASE_URL=postgres://.../taphoa_eval pnpm --filter @taphoa/eval test:integration
```

They compare every oracle value with `src/oracle/__snapshots__/`. When the seed changes on
purpose, review the diff and run the tests with `-u`.
