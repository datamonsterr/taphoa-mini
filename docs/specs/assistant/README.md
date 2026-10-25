# Assistant, Clerk identity, debt book and observability: program spec

Status: Accepted · Date: 2026-10-25 · ADRs: [0004](../../adr/0004-clerk-identity.md),
[0005](../../adr/0005-assistant-in-backend.md), [0006](../../adr/0006-telemetry-routing.md)

## Goal

Give the shop owner an in-app **assistant** that reads and analyzes store data through
assistant tools, tells them what to restock and what to do next, and drafts actions they
confirm. Replace our own auth with **Clerk** so every trace, log and product event belongs to
a person. Add a **debt book (sổ nợ)** to checkout. Instrument the whole system with
**OpenTelemetry**, ship assistant traces and evaluations to self-hosted **Langfuse**, and ship
product analytics, logs, errors and session replay to **PostHog Cloud US**. Every piece is
built test-first and validated on Railway `test`, then production.

## Documents

| File                                           | Content                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| [epics.md](epics.md)                           | Epic briefs: scope, owned files, tasks, acceptance, out of scope             |
| [assistant.md](assistant.md)                   | Use cases, tool catalog, API contract, UI (chat button, strip, receipt chat) |
| [auth-clerk.md](auth-clerk.md)                 | Clerk integration contract and migration                                     |
| [debt-book.md](debt-book.md)                   | Debt book data model, API and flows                                          |
| [telemetry-contract.md](telemetry-contract.md) | Span, log and product-event names and attributes; collector routing          |
| [dashboards.md](dashboards.md)                 | Langfuse and PostHog chart catalog with the data each chart needs            |
| [golden-set.md](golden-set.md)                 | Golden set design, scoring, pass bars, model selection                       |

## Definition of done (whole program)

| #   | Done when                                                                                                                                                                            | Proven by                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 1   | A chat button sits at the bottom right next to the tab bar on every shop screen and opens the assistant; replies stream in Vietnamese (or English when the app language is English). | Jest + Playwright web + Maestro flows               |
| 2   | All use cases U1-U23 in [assistant.md](assistant.md) work end to end on Railway `test` with a free OpenRouter model; propose tools never write before Confirm.                       | Golden set + e2e `assistant.test.ts`                |
| 3   | Next-step strip under the camera frame shows ranked chips and swipes horizontally; receipts are processed in chat; voice input works on Android.                                     | Jest, Maestro, e2e                                  |
| 4   | Golden set (about 140 Vietnamese cases) meets the pass bars in [golden-set.md](golden-set.md) for the chosen default model; runs appear as Langfuse dataset runs with scores.        | `pnpm --filter @taphoa/eval run full` + Langfuse UI |
| 5   | Clerk replaces our auth (email code + Google, multi-session, PIN lock); legacy refresh/recovery/switch endpoints are gone; data reset and reseeded.                                  | e2e `auth.test.ts`, Maestro sign-in flow            |
| 6   | Debt book: credit sales (full or partial) at checkout, repayments, balances, reminders; chốt sổ counts cash repayments.                                                              | Rust integration + e2e `debts.test.ts` + Maestro    |
| 7   | Langfuse runs in Railway `production`; every chart in [dashboards.md](dashboards.md) "Langfuse" section exists and shows real data from `test` and `production`.                     | DoD report screenshots + Langfuse API queries       |
| 8   | PostHog has every dashboard in [dashboards.md](dashboards.md) "PostHog" section with real data; logs, error tracking and masked session replay receive data.                         | DoD report screenshots + PostHog API queries        |
| 9   | Every span, log and event follows the [telemetry contract](telemetry-contract.md); a trace or event can be traced to a Clerk user and a store in both tools.                         | Contract tests (in-memory exporter) + DoD report    |
| 10  | CI green, every epic PR merged into `main`, production deployed by the existing pipeline, worktrees cleaned per `AGENTS.md`.                                                         | `gh pr list --state merged`, `git worktree list`    |

The final DoD report lives at `docs/specs/assistant/dod-report.md` (written by epic X9).

## Settled decisions (do not reopen)

- **Auth:** ADR 0004. Clerk dev instance `full-moccasin-5407` for both environments; email
  code + Google; multi-session; stores and members in our DB; reset data.
- **Assistant:** ADR 0005. Backend agent loop; read + propose tools; confirm before any write;
  both roles, tools filtered by `auth::can`; Vietnamese default, follows the app language.
- **Model:** free OpenRouter tool-capable models only, ordered list `ASSISTANT_MODELS`; the
  account has 1,000 free requests per day shared by every environment and the eval.
- **Telemetry:** ADR 0006. Collector in Railway `production`; Langfuse in the same project
  (production environment only); PostHog Cloud US; session replay on with masking.
- **Use cases:** all of U1-U23 (expiry tracking is out of scope).
- **Receipts:** a detected document opens a chat thread that walks through the receipt; the
  old form stays one release as the "Xem dạng bảng" fallback.
- **Voice:** on-device speech recognition (`vi-VN`), no server speech model.
- **New entry points** go into the next-step strip, not as new buttons. Existing buttons stay.
- **Golden set:** Vietnamese only, about 140 cases, smoke 25 per PR, full nightly or on demand,
  at most one full run per day.
- **Push:** Expo push with FCM V1 for the daily digest, plus an in-app card.
- **Autonomy:** sessions may push, open PRs, merge to `main` after CI is green and a review
  passes, deploy `test`, create Railway services, set Railway/EAS/GitHub variables and let the
  pipeline deploy production.

## Epic graph and waves

```
Wave 1:  X0 contract ─────────┬──────────────┬──────────────┐
         X1 auth (Clerk) ─────┼──────────┐   │              │
         X2 observability ────┼──────┐   │   │              │
         X5 debt book (own contract) │   │   │              │
Wave 2:  X3 assistant backend (X0) ──┼───┼───┼── X8 push + digest (X3) ── Wave 3
         X4 assistant mobile (X0)    │   │   │
         X7 golden set + eval (X0; final run needs X3)
         X6 product analytics (X1, X2)
Wave 4:  X9 dashboards, integration and DoD validation (all)
```

| Epic | Branch                       | Depends on (merged into `main`) | Migrations |
| ---- | ---------------------------- | ------------------------------- | ---------- |
| X0   | `epic/x0-assistant-contract` | none                            | none       |
| X1   | `epic/x1-auth-clerk`         | none                            | `07xx`     |
| X2   | `epic/x2-observability`      | none                            | none       |
| X5   | `epic/x5-debt-book`          | none (debt tools wait for X3)   | `09xx`     |
| X3   | `epic/x3-assistant-backend`  | X0                              | `08xx`     |
| X4   | `epic/x4-assistant-mobile`   | X0                              | none       |
| X7   | `epic/x7-golden-set`         | X0 (final eval run needs X3)    | none       |
| X6   | `epic/x6-product-analytics`  | X1, X2                          | none       |
| X8   | `epic/x8-push-digest`        | X3                              | `10xx`     |
| X9   | `epic/x9-dashboards-dod`     | all                             | none       |

The program controller (the session that wrote this spec) starts each wave when its
dependencies are merged, answers questions from epic sessions, and runs nothing itself.

## Shared rules for every epic

- **Controller model.** Each epic session is a controller: it plans tasks, briefs workers,
  reviews diffs and merges. Workers edit source. Delegate through superorchestrator (load the
  `use-superorchestrator-mcp` skill first). When the superorchestrator MCP is unavailable or
  has no headroom, fall back to native subagents (`claude-sonnet-5-5` for judgment work,
  `claude-haiku-5-5` for mechanical work, medium effort), as the global CLAUDE.md says.
- **TDD.** Every task lands failing tests first, then code, then the acceptance commands green.
  Each worker brief names the exact test files.
- **Docs first.** Check current docs (context7, vendor docs) before coding against any library,
  SDK, CLI or vendor API. No API from memory. Record version pins you chose in the epic's spec
  section.
- **Contract.** `docs/api/openapi.yaml` and `docs/api/asyncapi.yaml` are the source of truth;
  regenerate `packages/api-client/src/schema.d.ts` after every change. Only X0 (assistant, push,
  next steps), X1 (auth) and X5 (debt) edit the contract. Others request changes from the
  program controller.
- **File ownership.** Edit only the files your epic owns (listed in [epics.md](epics.md)) plus
  the named integration points. Rebase on `main` before opening the PR and again before merge.
- **Migrations** use the epic's reserved range, are immutable once deployed to `test`, and are
  never edited across epics. X0 makes the migrator tolerate missing versions so branch deploys
  to the shared `test` database do not break `main` deploys.
- **E2E** specs live in `packages/e2e/tests/<module>.test.ts` and use the shared harness
  helpers to create stores and members. X1 swaps the helpers to Clerk; never call auth
  endpoints directly from a module spec.
- **Telemetry.** New handlers, jobs and tools follow the [telemetry contract](telemetry-contract.md).
  No secrets, tokens, names, emails, phone numbers or bank numbers in span or log attributes.
- **Secrets** never in git, logs, PRs or chat. Read them from `~/.config/taphoa-mini/secrets.env`
  locally, Railway variables on servers, EAS environment variables for the app and GitHub
  secrets for CI. New backend variables go into `.railway/railway.ts` (`preserve()` for
  secrets) and `.env.example`.
- **Railway `test`** is shared. Validate a branch with
  `gh workflow run deploy.yml -f ref=<branch>` (deploys are serialized). Never run
  `railway config apply` with a plan that deletes services, volumes or the Langfuse stack.
- **Free model quota** is shared (1,000 requests per day). Unit and integration tests use a
  mock model client. Only the eval harness and e2e assistant specs call OpenRouter, and the e2e
  assistant spec stays under 30 requests per run.
- **Merging.** Conventional Commits. One PR per epic. Merge when `ci-ok` is green, the branch
  deploy to `test` passes e2e, and a review (`/code-review` or `cavecrew-reviewer`) has no open
  correctness findings. Merge commits, not squash. After merge, watch the `Deploy backend`
  workflow until production smoke passes, then clean the worktree per `AGENTS.md`.
- **Reporting.** End every turn with a short status for the program controller: merged PR URL,
  DoD rows proven, anything left. Ask the program controller (not the user) when blocked on a
  cross-epic question; ask the user only for credentials or dashboard toggles.

## Secrets and variables map

| Name                                                            | Where                                                             | Owner epic |
| --------------------------------------------------------------- | ----------------------------------------------------------------- | ---------- |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`                     | Railway backend (test, production), local file; set               | X1         |
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`                             | EAS (all environments); set                                       | X1         |
| `OPENROUTER_API_KEY`                                            | Railway backend, local file; set (key expires 2026-11-23)         | X3         |
| `ASSISTANT_MODELS`, `ASSISTANT_DAILY_MESSAGES_PER_STORE`        | Railway backend                                                   | X3         |
| `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`                         | Railway backend (test, production); set                           | X2, X6     |
| `EXPO_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_POSTHOG_HOST`           | EAS (all environments); set                                       | X6         |
| `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`                | Local file only; set                                              | X6, X9     |
| `LANGFUSE_*` init, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Railway Langfuse services; local file and GitHub secrets for eval | X2         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`     | Railway backend (test uses the collector public domain)           | X2         |
| `COLLECTOR_BEARER_TOKEN`                                        | Railway collector + backend                                       | X2         |
| GitHub secrets for CI eval/e2e (Clerk, OpenRouter, Langfuse)    | `gh secret set`                                                   | X1, X7     |
| FCM V1 service account                                          | Uploaded to EAS credentials by the user                           | X8         |

## Waiting on the user (non-blocking for wave 1)

- Clerk dashboard: enable **multi-session** (single-session mode is on); roll the secret key.
  Needed by X1 before its multi-session e2e task.
- OpenRouter: a new key without expiry before 2026-11-23. Needed by X3 before production.
- FCM: `google-services.json` and the FCM V1 service account uploaded to EAS. Needed by X8.
