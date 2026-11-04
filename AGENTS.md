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
