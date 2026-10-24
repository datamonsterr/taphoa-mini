# taphoa-mini

Monorepo: Rust backend in `apps/backend`, Expo app in `apps/mobile` (rules in `apps/mobile/AGENTS.md`), shared packages in `packages/`. Project terms live in `CONTEXT.md`.

## Finishing a task

A task is done when its PR is merged into `main`. Each task runs in its own git worktree (usually under `.claude/worktrees/`). Rust build output in a worktree (`apps/backend/target`) takes several GB, so clean up every worktree after its merge:

1. Confirm the merge: `gh pr view <branch> --json state -q .state` prints `MERGED`, or `git branch --merged origin/main` lists the branch. Never clean up an unmerged worktree.
2. Free Rust build output: `cargo clean --manifest-path apps/backend/Cargo.toml` (run inside the worktree).
3. Remove the worktree from the main checkout: `git worktree remove <path>`. Do not pass `--force` when it refuses; the refusal means uncommitted work exists, so report it instead.
4. Delete the local branch: `git branch -d <branch>`, then run `git worktree prune`.

Do this for nested worktrees too (for example `<worktree>-worktrees/*`). Run `git worktree list` at the end and report what is left.
