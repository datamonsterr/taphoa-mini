# taphoa-mini

Monorepo: Rust backend in `apps/backend`, Expo app in `apps/mobile` (rules in `apps/mobile/AGENTS.md`), shared packages in `packages/`. Project terms live in `CONTEXT.md`.

Test helpers must not do expensive per-process setup, such as RSA key generation, without caching it on disk or optimizing the crate. See the `opt-level = 3` profile overrides for `rsa` and `num-bigint-dig` in `apps/backend/Cargo.toml`.

## Finishing a task

A task is done when its PR is merged into `main`. Each task runs in its own git worktree (usually under `.claude/worktrees/`). Rust build output in a worktree (`apps/backend/target`) takes several GB, so clean up every worktree after its merge:

1. Confirm the merge: `gh pr view <branch> --json state -q .state` prints `MERGED`, or `git branch --merged origin/main` lists the branch. Never clean up an unmerged worktree.
2. Free Rust build output only when the worktree has its own `apps/backend/target`. Check `cargo metadata --format-version 1 --no-deps --manifest-path apps/backend/Cargo.toml` for `target_directory`: if it points outside the worktree (a shared `build.target-dir`, as on the owner's machine), **never** run `cargo clean`, because it wipes the cache every worktree shares. Otherwise run `cargo clean --manifest-path apps/backend/Cargo.toml` inside the worktree.
3. Remove the worktree from the main checkout: `git worktree remove <path>`. Do not pass `--force` when it refuses; the refusal means uncommitted work exists, so report it instead.
4. Delete the local branch: `git branch -d <branch>`, then run `git worktree prune`.

Do this for nested worktrees too (for example `<worktree>-worktrees/*`). Run `git worktree list` at the end and report what is left.

<!-- prettier-ignore-start -->

## CI/CD Resource & Push Policy
This account shares 40 concurrent GitHub Actions slots across all repos and a 3,000 min/month private-repo budget. Treat CI as a final verification gate, NOT a scratchpad.

1. **Verify locally before pushing:** Run the repo's local check task (`mise run check`, `cargo clippy`, `pnpm lint && pnpm typecheck && pnpm test`) and confirm it passes before `git push`.
2. **Batch commits:** Do not push after every small edit. Commit locally and push only when a logical milestone passes local checks.
3. **Draft PRs first:** Always open new PRs as `--draft` (`gh pr create --draft`). Only mark ready (`gh pr ready`) once local checks pass and implementation is complete.
4. **No unnecessary heavy triggers:** Do not add `e2e` or `bench` labels unless explicitly requested.
5. **Workflow hygiene:** Every new GitHub Actions workflow MUST include `concurrency` (`cancel-in-progress: true`), `timeout-minutes` on every job, and path filters. Never add `macos-*` or `windows-*` jobs to private PR triggers.

<!-- prettier-ignore-end -->
