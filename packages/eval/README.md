# @taphoa/eval

Evaluation harness for the assistant (epic X7). It holds the golden set of
Vietnamese and English cases, the scorers, the oracle queries, and the runner
that drives `@taphoa/api-client` against the assistant.

This package is a scaffold. It has the shared types in `src/types.ts` and a
placeholder `src/cli.ts`. The commands (`validate`, `smoke`, `full`, `compare`,
`calibrate`) come in later tasks. Run them with `pnpm --filter @taphoa/eval <command>`.

Plan: `docs/specs/assistant/x7-plan.md`.
