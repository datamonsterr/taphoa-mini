# Roadmap, November 2026

Status: Draft · Date: 2026-11-23 · Base: `origin/main` at `5672aa41` (PR #362)

Goal: every spec'd feature works, and the app is simple and fast for an elderly shopkeeper on a
cheap Android phone. This file lists the current state with evidence, then an ordered task plan.

How this was produced: GitHub PRs, issues and CI runs read with `gh`; live probes of the production
and test URLs; code and docs read at `5672aa41`. Nothing was built or run locally. Rows marked
_(inferred)_ rest on grep evidence only and need a second look before work starts.

## 1. State on 2026-11-23

### 1.1 What changed since the 2026-11-21 notes

| 2026-11-21 note                                    | Now                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| About 12 open Dependabot PRs                       | None open. #335, #339, #341, #342, #344, #346, #347, #348 merged; #340, #343, #345 landed through #360.                                                                                                                                                                    |
| CI jobs queue for a self-hosted runner             | No workflow hard-codes `self-hosted`. Zero runners are registered. `CI_HEAVY_RUNNER` and `CI_ANDROID_RUNNER` are optional repo variables with an `ubuntu-latest` fallback, and neither is set.                                                                             |
| Test Postgres crashed                              | Superseded. The `test` environment is ephemeral since #349 and #359 ([deploy.md](../deploy.md#railway-test-environment)): Postgres, Redis and the backend exist only during a deploy run. `backend-test-70c2` answers 404 "Application not found" between runs, by design. |
| #343 fails typecheck, #346 to #348 fail model-test | Fixed (#360, and the cargo bumps merged).                                                                                                                                                                                                                                  |
| Production `/healthz` ok                           | Still ok. `/readyz` returns `{"status":"ok","storage":"ok"}`.                                                                                                                                                                                                              |
| Draft PR #301                                      | Still open, now conflicting.                                                                                                                                                                                                                                               |
| Owner issues #47, #48, #49, #52, #59, #60, #138    | All still open.                                                                                                                                                                                                                                                            |
| Design gaps #316, #320                             | Fix PRs merged (#327, #330, #332). Issues stay open until a re-capture confirms them.                                                                                                                                                                                      |

### 1.2 Blockers found

1. **`Deploy backend` has not passed since 2026-11-04.** 21 failures, 26 skips, 0 successes since
   then. In the latest run (44998809315) the `test` job fails five voice e2e tests with
   `503 voice_unavailable`, so the `production` job is skipped.
2. **Likely cause: OpenRouter credit or key limit.** The scheduled `eval full` run on the same day
   failed with "OpenRouter credits too low: $0.4641 remain; estimated budget $1.2200". A comment on
   #138 says the `test` and `production` keys are capped at $1 each. Not confirmed that the test
   backend's key is the exhausted one; Railway logs after #362 will show the upstream status.
   If the production key shares the limit, voice sale and the assistant are down in production too.
3. **The test gate does not gate production.** `.railway/railway.ts:78-84` links the production
   backend to GitHub `main` with `checkSuites: true`, so Railway deploys on its own. Production
   already serves `POST /v1/recognition/warm` (added 2026-11-21, returns 401 not 404) although no
   deploy run has passed since 2026-11-04. Result: 145 commits reached production without the
   deployed e2e suite passing, and the post-deploy steps in the `production` job have not run.
4. **Blocking e2e calls a paid model.** `voice.test.ts` (21 clips) runs against real OpenRouter in
   the blocking part of every main deploy. A spent budget turns every deploy red.
5. **Android E2E `voice-bubble` flow fails** in 3 of the last 4 runs (44996180593, 44994559724,
   44983319187): `Assertion is false: "Ô cài đặt nhanh" is visible`, also on retry.
6. **Preview and test APKs point at a backend that is usually down.** `apps/mobile/eas.json`
   (`preview`, `test`) and `android-apk.yml` default to `backend-test-70c2` (ephemeral, see [deploy.md](../deploy.md#railway-test-environment)). This blocks the
   real-device checks in #60 and #138 unless a deploy run is held open with `keep_test_backend`.
7. **PR #301** (hybrid capture, +12,622 / -1,540, 223 files, 71 commits) conflicts with `main`;
   `expo-go` and `rust-integration (2/2)` are red; three acceptance gates are unmeasured.

### 1.3 Pull requests and branches

| Item                                                                                                | Action                                                              | Why                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #301 hybrid object capture (draft)                                                                  | **Do not merge as is. Split and rebase** (tasks R1 to R4)           | Too large to review, conflicts, raises Android `minSdk` to 26, grows the image by about 355 MiB and startup RSS to about 1.34 GiB, which works against the lazy-model work in #351. |
| #288 camera 20 s scan bound (closed, unmerged), branch `claude/fix-camera-180-182`                  | Check whether #358 or later work covers it; delete the branch if so | One commit ahead of `main`.                                                                                                                                                         |
| `claude/frontend-superorchestrator-5048d6` and `so/fx3-visual-polish-*`                             | Delete after confirming                                             | Their PR #14 merged; the commits were squashed.                                                                                                                                     |
| `origin/dependabot/*` (3 branches), `origin/claude/*` (6), `origin/docs/design-audit-harness-*` (3) | Delete                                                              | Their PRs are merged or replaced. Keep `eval/results` and `evidence/*` if issues link to them; #316 and #320 link to `docs/design-audit-2026-11-07`.                                |
| 21 local worktrees                                                                                  | Clean up by the `AGENTS.md` procedure (task H4)                     | Most belong to merged branches. Root disk is at 62 %.                                                                                                                               |

### 1.4 Open issues

| Issue                                                   | Type                   | State                                                      | Task           |
| ------------------------------------------------------- | ---------------------- | ---------------------------------------------------------- | -------------- |
| #47 Clerk production instance                           | owner, security        | Production signs in through the Clerk development instance | P1             |
| #48 rotate Clerk dev secret                             | owner, security        | Secret was pasted in a transcript                          | P2             |
| #49 OpenRouter quota                                    | owner                  | Key limits still $1                                        | U1             |
| #52 verify reset, image cleanup, reseed                 | owner                  | Script exists: `scripts/ops/delete_orphan_images.py`       | P4             |
| #53 iOS push                                            | owner, later           | Needs an APNs key                                          | L1             |
| #59 rotate collector token                              | owner, security        | Goes away if the collector is retired                      | P3             |
| #60 digest push on a real phone                         | owner                  | Needs a reachable test build                               | P5             |
| #67 synthetic PostHog events                            | owner                  | Recheck the count; close at 0                              | P6             |
| #74 Epic V4 iOS entry points                            | later                  | No iOS build exists                                        | L1             |
| #115 embedder top-1 accuracy                            | owner data, then agent | Evaluator exists; data set A1 does not                     | R5             |
| #138 voice on a real phone, Play Console                | owner                  | Needs a reachable test build                               | P5             |
| #316 design gap: inventory, units, stock filter, export | agent                  | Fixed in #327; needs re-capture                            | H1             |
| #320 design gap: board data                             | agent                  | Fixed in #330 and #332; digest unit chip unverified        | H1             |
| #46, #54 assistant trackers                             | tracker                | Done except #67                                            | close after P6 |

## 2. Feature matrix

Status: **done** (code and tests found), **partial**, **broken**, **missing**. PRD ids (C1, S2, …)
are from `docs/PRD.md` section 5. Backend paths are under `apps/backend/crates/api/`, mobile paths
under `apps/mobile/src/`.

### 2.1 Core product (PRD section 5)

| Feature                                       | Backend           | Mobile                   | Evidence                                                                                                                                     | Gap                                                                                                |
| --------------------------------------------- | ----------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C1, C4 product create, edit, archive          | done              | done                     | `src/catalog/mod.rs:24-33`, `tests/catalog.rs`; `features/enroll/EnrollScreen.tsx`, `features/product`                                       | none                                                                                               |
| C2 duplicate check                            | done _(inferred)_ | done                     | `src/catalog/products.rs`                                                                                                                    | Confirm the merge path has a test.                                                                 |
| C3 price history                              | done              | **partial**              | `src/catalog/mod.rs:30-33`; no mobile caller of `/v1/products/{id}/price-history`                                                            | History is never shown (F1).                                                                       |
| C5 units, categories                          | done              | done                     | `src/catalog/mod.rs:20-23`; `UnitsEditor.tsx`                                                                                                | none                                                                                               |
| C6 product photos                             | done              | done                     | `src/catalog/mod.rs:35-40`                                                                                                                   | none                                                                                               |
| C7 price-list export (P2)                     | done              | **missing**              | `src/catalog/export.rs:366,600`, `tests/price_list_export.rs`; no mobile caller                                                              | F5, or cut from scope.                                                                             |
| S1, S8 camera identify, multi-item            | done              | done                     | `src/recognition/handlers.rs:36-55`, `tests/recognition.rs`; `features/camera/CameraScreen.tsx`                                              | Accuracy unmeasured (#115).                                                                        |
| S2 barcode                                    | **unconfirmed**   | done                     | `features/camera/useBarcodeScanner.ts`, Maestro `barcode.yaml`; backend shows `barcode` only as a sale input source (`src/sales/mod.rs:126`) | Confirm how a scanned code finds a product (F3).                                                   |
| S3, S5, S6 cart, cash, VietQR                 | done              | done                     | `src/sales/mod.rs:29-31`, `tests/sales.rs`; `features/pay/PayScreen.tsx:261`                                                                 | none                                                                                               |
| S4 unknown item, manual price, review queue   | done              | **partial** _(inferred)_ | `src/sales/review.rs:6-7`; app calls `/v1/review/manual-lines`                                                                               | Lead's review screen not located (F4).                                                             |
| S7 speak the total                            | n/a               | done                     | `features/pay/speak.ts`                                                                                                                      | No e2e flow.                                                                                       |
| S9 automatic transfer confirmation (P2)       | **missing**       | missing                  | `sale.payment_confirmed` is in AsyncAPI, no emitter                                                                                          | Out of MVP (L4).                                                                                   |
| S10 void a sale                               | done              | done                     | `src/sales/mod.rs:31`; `features/sales/SaleDetailScreen.tsx`, `e2e-web` void spec                                                            | Reached only from one Dashboard link.                                                              |
| E1 expenses                                   | done              | **partial**              | `src/expenses/mod.rs:30-33`; `app/expense.tsx`                                                                                               | No edit or delete in the app (F2).                                                                 |
| E2, E4, E6 purchases, stock, low-stock alerts | done              | done                     | `src/stock/mod.rs:152-160`; `features/stock/StockScreen.tsx`, `features/stock-alerts`                                                        | Jest only; no e2e.                                                                                 |
| E3 margin alerts                              | done              | **partial** _(inferred)_ | `src/expenses/mod.rs:35-37`                                                                                                                  | Confirm where the alert is shown (F4).                                                             |
| E5 receipt photo to stock                     | done              | done                     | `src/receipts/http.rs:31-33`, `tests/receipts.rs`; `ReceiptReviewScreen.tsx`, Maestro `receipts.yaml`                                        | none                                                                                               |
| R1, R3, R4 reports                            | done              | **partial**              | `src/reports/mod.rs:21-24`; `DashboardScreen.tsx`                                                                                            | `/v1/reports/top-products` and `/v1/reports/recognition` have no UI (F5).                          |
| R2 day close                                  | done              | done                     | `src/reports/mod.rs:26-29`, `tests/close_bounds.rs`; `features/close/CloseScreen.tsx`                                                        | No Maestro flow.                                                                                   |
| R5 transactions export                        | done              | done                     | `src/reports/mod.rs:25`; `shareExport.ts`                                                                                                    | none                                                                                               |
| U1 to U4 sign-in, store, invites, roles, PIN  | done              | **partial**              | `src/auth/mod.rs:16-21`, `tests/permissions.rs`; `features/account`                                                                          | No mobile caller of `/v1/members/{id}`: cannot remove a member or change a role _(inferred)_ (F2). |
| T1 to T3 settings                             | done              | done                     | `src/store/mod.rs:60-119`; `AccountScreen.tsx`                                                                                               | One long screen (X4).                                                                              |

Contract check: all 83 OpenAPI path and method entries have a registered route; no `todo!`,
`unimplemented!` or 501 handlers. Of 29 AsyncAPI messages, `sale.payment_confirmed` has no emitter
and `embedding.backfill` has none that grep finds.

### 2.2 Programs beyond the PRD

| Program                                             | Status                                                 | Evidence                                                                  | Gap                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Quick enroll                                        | done                                                   | PRs #25, #137; `tests/segment_points.rs`, Maestro `quick-enroll.yaml`     | none                                                                                                 |
| Recognition latency (scan p95 < 3 s)                | done, loosely verified                                 | 2,101 to 2,585 ms on Railway `test` (`docs/specs/recognition-latency.md`) | The e2e test checks p90 of 12 runs, the spec says p95 of 5. Runs are soft, non-blocking.             |
| Recognition accuracy (top-1 ≥ 90 %)                 | **unmeasured**                                         | #115; `scripts/embed-accuracy.sh`                                         | Needs the owner's shop photos. Public-data result for the current embedder is 35.9 % (PR #301 eval). |
| Lazy model load and unload, app warm call           | done                                                   | #351, #353; `tests/model_warm.rs`, `useWarmRecognition`                   | Receipt screen does not warm _(inferred)_.                                                           |
| GPU worker with CPU fallback (G1 to G4)             | done in code, **not wired in production** _(inferred)_ | #354, #361; `src/remote_models.rs`, `crates/infer`                        | G5 tunnel and G6 measurement open.                                                                   |
| Voice V0, V1, V2, V5, V6                            | done                                                   | `src/voice`, `tests/voice.rs`, Maestro `voice.yaml`                       | **Currently failing on `test` (503)**, see 1.2.                                                      |
| Voice V3 Android entry points                       | partial                                                | #117 merged; #138 open                                                    | Real-phone run, Play Console forms; `voice-bubble` flow red.                                         |
| Voice V4 iOS                                        | missing                                                | #74                                                                       | No iOS build at all.                                                                                 |
| Assistant X0 to X9                                  | done                                                   | #54; 10 `tests/assistant_*.rs`                                            | Hidden behind PostHog flag `assistant_enabled`. Depends on OpenRouter credit.                        |
| Debt book, customers                                | done                                                   | `src/debts/mod.rs:64-78`, Maestro `debts.yaml`                            | Eval seed lacks debt scenarios (`src/seed/eval/insert.rs:63,708`).                                   |
| Daily digest and push                               | done on Android, unverified on a device                | `tests/push.rs`; #60                                                      | iOS push missing (#53).                                                                              |
| Stock receipts and OCR                              | done                                                   | PRs #27, #109; OCR p95 1,349 ms                                           | none                                                                                                 |
| Offline: outbox and cached catalog                  | done                                                   | `lib/outbox`, `lib/offline`, `e2e-web` offline spec                       | Reports, sales list and debts need the network (by ADR 0009).                                        |
| Sync and events (E6)                                | done on the backend, **unused by the app**             | `tests/sync.rs`, `events_stream.rs`                                       | The app polls instead of using `/v1/events` (O3).                                                    |
| Ephemeral test env, lazy models (cost A1 to A3, A6) | done                                                   | #349, #359                                                                | Invoice target unverified.                                                                           |
| Telemetry without the collector (A4)                | partial                                                | #350                                                                      | Owner must switch the variables; collector still declared in `railway.ts:202`.                       |
| Cost phase B (B0 to B9: Cloud Run, Supabase, R2)    | missing                                                | `docs/specs/serverless-cost.md`                                           | Gated on spike B0; owner decision.                                                                   |
| Landing and waitlist                                | done                                                   | #303, #304; `tests/waitlist.rs`                                           | Custom domain and CSP open.                                                                          |
| iOS app                                             | missing                                                | No EAS iOS profile, no `targets/`                                         | Needs an Apple developer account.                                                                    |

### 2.3 Definition-of-done items not verifiable from the repo

- Hot endpoints p95 < 200 ms: gated by `packages/e2e/tests/latency.test.ts`, soft. One recorded run
  had `/v1/sync/changes` at 218 ms.
- Each CI job under 3 minutes warm: no record.
- `docs/data-model.md` lacks about 20 tables that migrations create (assistant, voice, debts,
  devices, push, sessions, waitlist).

## 3. UI and UX review

### 3.1 Structure

The core loop (camera, cart, pay, offline outbox) is sound. The problem is the number of entry
points around it: 22 routes, three tabs plus a camera button, an assistant button and a voice
bubble. The Dashboard works as a menu for six features, and stock, receipts and the "Kho" tab
overlap. For this user, merging entry points matters more than raw speed.

### 3.2 Findings, ranked by user impact

| #   | Impact | Size | Where                                                                                                  | Problem                                                                                         | Change                                                                                         |
| --- | ------ | ---- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | H      | M    | `app/(shop)/_layout.tsx:15-31`, `features/stock/StockSegment.tsx:26`                                   | Tab "Kho" is the inventory grid; "stock" is a separate pushed route                             | One tab with two segments, no route push                                                       |
| 2   | H      | M    | `features/dashboard/DashboardScreen.tsx:52,53,142,162`, `ShortcutChips.tsx:35`                         | Expense, close, debts, sales, receipts, digest all hang off the Dashboard                       | One row of daily actions (Chi, Chốt sổ, Công nợ); one "Nhập hàng" entry for receipts and stock |
| 3   | H      | S    | `lib/offline/persist.ts:52-57`                                                                         | No default `staleTime`, so most queries refetch on every mount                                  | Default 30 to 60 s; reports 5 min                                                              |
| 4   | H      | S    | `stores/settings.ts:20`, `features/home/Home.tsx:20-40`                                                | Elder mode is off by default and only changes the start screen                                  | Ask in onboarding; decide the default (owner)                                                  |
| 5   | M      | S    | Maestro `checkout.yaml`                                                                                | About 6 taps from shutter to a finished cash sale                                               | Show Cash and QR on the cart; skip the cart when one scan is confirmed                         |
| 6   | M      | M    | `features/receipts/ReceiptReviewScreen.tsx` (780 lines), `ReceiptHistoryScreen.tsx`, `StockScreen.tsx` | Three screens for one workflow                                                                  | One "Nhập hàng" screen with history and review                                                 |
| 7   | M      | M    | `features/account/AccountScreen.tsx` (625 lines)                                                       | Bank, PIN, people, devices, thresholds, font, elder mode, voice in one scroll                   | Three groups; devices and voice setup under "Nâng cao"                                         |
| 8   | M      | S    | `features/stock-alerts/useLowStockWatcher.ts:51-57`                                                    | Polls two lists on a timer for the whole session                                                | Refetch on foreground, or use `/v1/events`                                                     |
| 9   | M      | S    | `app/_layout.tsx:20-60`                                                                                | Returns `null` until five font weights load; PostHog and `OfflineSync` start before first paint | Load two weights first; defer the rest _(not profiled)_                                        |
| 10  | M      | M    | `features/camera/CameraScreen.tsx` (1,069 lines, 7 `useState`, 7 `useEffect`, routes to 7+ places)     | Hard to change safely; whole screen re-renders                                                  | Extract `useScanFlow` and `useCameraActions`                                                   |
| 11  | M      | M    | `features/pay/PayScreen.tsx` (810 lines)                                                               | Cash, QR, change, speech, outbox in one component                                               | Cash panel, QR panel, `useCheckout`                                                            |
| 12  | M      | S    | Sales list, digest lists                                                                               | `ScrollView` with `.map` _(inferred)_; `ReceiptHistoryScreen` uses `FlatList`                   | FlashList, which four other screens already use                                                |
| 13  | M      | S    | 84 `fontSize:` literals outside `src/theme` (e.g. `NextStepChip.tsx:83`, `ProductTile.tsx:138`)        | May bypass the user's text-size setting                                                         | Typography tokens; add a lint rule                                                             |
| 14  | M      | S    | `components/Stepper.tsx:54,74`, `Switch.tsx:42`                                                        | `hitSlop` 2 and 6 on the most-used controls                                                     | Meet the 48 dp target                                                                          |
| 15  | M      | S    | `package.json`                                                                                         | `posthog-js` ships beside `posthog-react-native`                                                | Check the bundle-budget output; drop it from native if unused                                  |
| 16  | L      | S    | `lib/api/hooks.ts` (787 lines)                                                                         | All query hooks in one file                                                                     | Split by feature                                                                               |
| 17  | L      | S    | `features/camera/capture.ts:67-88`                                                                     | Camera JPEG quality 0.3                                                                         | Keep; confirm it does not hurt accuracy once R5 has data                                       |

### 3.3 Libraries

No upgrade is recommended beyond what Dependabot already delivers. Registry versions checked on
2026-11-23: `expo` 58.0.26 (repo `~58.0.19`), `react-native` 0.88.1 (0.88.0),
`react-native-reanimated` 4.8.0 (4.7.1), `@clerk/expo` 4.17.4 (`^4.14.2`), `@shopify/flash-list`
2.3.3 (same), `ort` 2.0.0-rc.15 (same, still a release candidate). All gaps are patch or minor and
inside the declared ranges. Dependabot security alerts are disabled for the repository.

The documentation server was unreachable during this review. PR #301 adds VisionCamera v5 and an
ML Kit module; read their current docs and the Expo SDK 58 docs before task R3.

## 4. Task plan

Sizes: S under half a day, M up to two days, L more. Owner: **owner** needs a dashboard, a secret,
a payment, a device or a product decision; **agent** can be done from the repo.

### M0. Unblock delivery (start now)

| ID  | Task                                                                       | Acceptance criteria                                                                                                                                                                                         | Deps              | Size | Who                                | Ref                         |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---- | ---------------------------------- | --------------------------- |
| U1  | Restore OpenRouter credit and raise the `test` and `production` key limits | A voice utterance on production returns 201; credit covers one `eval full` run ($1.22) with margin                                                                                                          | none              | S    | owner                              | #49, #138                   |
| U2  | Confirm the 503 cause from Railway logs of a held test run                 | The upstream status and body from #362's diagnostics are quoted in the issue                                                                                                                                | U1 optional       | S    | agent, with owner's Railway access | #362                        |
| U3  | Take paid model calls out of the blocking deploy e2e                       | With an empty OpenRouter budget the `test` job passes; live voice clips run in the soft group and in `eval`; contract paths (validation, quota 429, 503 mapping) still block                                | none              | M    | agent                              | deploy.yml, `packages/e2e`  |
| U4  | Decide and implement one production release path                           | Either Railway auto-deploy is off and `deploy.yml` deploys production after `test` passes, or the docs state that the test job is a post-merge check and a failure opens an alert. `docs/deploy.md` matches | owner decision D1 | M    | agent                              | `.railway/railway.ts:78-84` |
| U5  | Fix or quarantine the `voice-bubble` Maestro flow                          | Android E2E passes 5 runs in a row on `main`; if quarantined, an issue tracks it                                                                                                                            | none              | M    | agent                              | run 44996180593             |
| U6  | Give test builds a reachable backend                                       | A documented command builds an APK and holds a test backend for N hours, or `preview` builds target production with a test store. `eas.json` and `android-apk.yml` match                                    | owner decision D2 | S    | agent                              | #60, #138                   |
| U7  | Add budget alerts                                                          | Low OpenRouter credit produces a notification before voice fails; the eval job reports "skipped: budget" instead of failing                                                                                 | U1                | S    | agent                              | `eval.yml`                  |

Exit: `Deploy backend` is green on `main` twice in a row, Android E2E is green, voice works in
production.

### M1. Close the feature gaps

| ID  | Task                                                             | Acceptance criteria                                                                                                                                         | Deps              | Size   | Who   | Ref        |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ | ----- | ---------- |
| F1  | Show price history on the product screen                         | Product screen lists who changed the price and when; Jest and web e2e cover it                                                                              | none              | S      | agent | C3         |
| F2  | Expense edit and delete; member remove and role change           | Lead can do each from the app; permission tests cover seller denial; first confirm the backend routes exist                                                 | none              | M      | agent | E1, U2, U3 |
| F3  | Confirm barcode lookup end to end                                | A test scans a code and gets the product through the real API; if the backend lacks a lookup, add it test-first                                             | none              | S to M | agent | S2         |
| F4  | Verify the manual-price review queue and margin alerts in the UI | Each has a reachable screen and a test, or an issue describes what is missing                                                                               | none              | S      | agent | S4, E3     |
| F5  | Decide the unused endpoints                                      | For top-products, recognition report, price-list export, day-close list: either a UI exists or the endpoint is marked internal or removed from the contract | owner decision D3 | S to M | agent | R3, R4, C7 |
| F6  | Complete the eval seed for debts                                 | `TODO(X5)` items at `src/seed/eval/insert.rs:63,708` are done; assistant debt evals use seeded customers                                                    | none              | S      | agent | X5         |
| F7  | Add Maestro flows for close, expense and void                    | Three flows pass in Android E2E                                                                                                                             | U5                | M      | agent |            |
| H1  | Re-capture the design audit and close #316, #320                 | Captures match the boards, including the digest unit chip with catalog units                                                                                | none              | S      | agent | #316, #320 |

### M2. Simplify the app

Do X1 first: it sets the navigation the other tasks build on. Each task starts with a board update
in `docs/design` and a failing test.

| ID  | Task                                                          | Acceptance criteria                                                                                             | Deps              | Size | Who                   | Ref          |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------- | ---- | --------------------- | ------------ |
| X1  | Navigation proposal                                           | A one-page design note lists the final tabs, entry points and removed routes; owner approves                    | owner decision D4 | S    | agent, owner approves | 3.2 #1, #2   |
| X2  | Merge stock into the inventory tab                            | No `/stock` route push; one tab, two segments; e2e updated                                                      | X1                | M    | agent                 | 3.2 #1       |
| X3  | One "Nhập hàng" flow and a daily-actions row on the Dashboard | Receipts history, review and stock intake are one flow; expense, close and debts are one tap from the Dashboard | X1                | L    | agent                 | 3.2 #2, #6   |
| X4  | Group settings                                                | Three groups; advanced items collapsed; no option lost                                                          | X1                | M    | agent                 | 3.2 #7       |
| X5  | Shorten the sale                                              | A one-item cash sale takes at most 4 taps after the shutter, measured in the Maestro flow                       | X1                | M    | agent                 | 3.2 #5       |
| X6  | Elder mode in onboarding                                      | New store is asked once; default per D5; the setting still lives in the account tab                             | owner decision D5 | S    | agent                 | 3.2 #4       |
| X7  | Touch targets and text scale                                  | Stepper and Switch reach 48 dp; no `fontSize` literal outside the theme; lint rule added                        | none              | M    | agent                 | 3.2 #13, #14 |

### M3. Make it fast

| ID  | Task                                 | Acceptance criteria                                                                                                                                                 | Deps | Size | Who   | Ref          |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ----- | ------------ |
| O1  | Query defaults                       | Default `staleTime` set; cart → pay → back fires no refetch (asserted in a test); `me` stays always-fresh                                                           | none | S    | agent | 3.2 #3       |
| O2  | Startup                              | Time to first paint measured before and after on the Android emulator job; fonts no longer block on five weights; PostHog and `OfflineSync` start after first paint | none | M    | agent | 3.2 #9       |
| O3  | Replace low-stock polling            | No session-long timer; alerts still appear within the spec'd delay                                                                                                  | none | S    | agent | 3.2 #8       |
| O4  | Split `CameraScreen` and `PayScreen` | Each file under about 400 lines; existing tests pass unchanged; cart edits do not re-render the viewfinder                                                          | X5   | L    | agent | 3.2 #10, #11 |
| O5  | Lists and bundle                     | Sales and digest lists use FlashList; `posthog-js` absent from the Android bundle if unused; bundle budget unchanged or lower                                       | none | S    | agent | 3.2 #12, #15 |
| O6  | Make latency gates real              | `recognition-latency` and `latency` e2e use the spec's statistic; a failure is visible (issue or red soft job summary)                                              | U3   | S    | agent | 2.3          |

### M4. Recognition quality

| ID  | Task                                                 | Acceptance criteria                                                                                                                                   | Deps              | Size | Who                            | Ref                  |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---- | ------------------------------ | -------------------- |
| R5  | Collect data set A1 and measure the current embedder | About 50 products and 200 labelled scans from the owner's shop; top-1 reported on #115                                                                | none              | M    | owner collects, agent measures | #115                 |
| R1  | Split #301: eval harness                             | Harness and GroceryStoreDataset buckets merged alone; no runtime change                                                                               | none              | M    | agent                          | #301                 |
| R2  | Split #301: retrieval v2 behind `EMBEDDER`           | 224 px letterbox, kNN voting, migrations 1306 to 1308, SigLIP2 optional; default unchanged; RSS and image size recorded against the lazy-load targets | R1, R5            | L    | agent                          | #301                 |
| R3  | Split #301: native camera and code mode              | VisionCamera and ML Kit module behind a flag; `minSdk` 26 approved; `expo-go` job fixed or replaced                                                   | owner decision D6 | L    | agent                          | #301                 |
| R4  | Split #301: one-trip enrollment                      | Gates C1 (≤ 16 s per product) and C3 (identify p95 ≤ 8 s) measured on a mid-range phone                                                               | R2, R3, U6        | L    | agent, owner device            | #301                 |
| R6  | Wire the GPU worker or drop it                       | G5 tunnel chosen, G6 measured from production (scan p95 ≤ 2,101 ms), or the worker is documented as unused                                            | owner decision D7 | M    | owner, agent                   | `serverless-cost.md` |

After R1 to R4 merge, close #301.

### M5. Production hardening (mostly owner)

| ID  | Task                                                         | Acceptance criteria                                                                                     | Size | Who                           | Ref       |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---- | ----------------------------- | --------- |
| P1  | Clerk production instance                                    | Production signs in on a production instance with its own domain                                        | M    | owner, agent for config       | #47       |
| P2  | Rotate the Clerk development secret                          | New key in Clerk, GitHub, Railway, EAS; old key revoked                                                 | S    | owner                         | #48       |
| P3  | Switch telemetry to direct export, then retire the collector | PostHog receives traces for a week without the collector; service removed from `railway.ts`; #59 closed | M    | owner switches, agent removes | #59       |
| P4  | Verify reset, image cleanup and reseed                       | Script run on both buckets; result on #52                                                               | S    | owner                         | #52       |
| P5  | Real-device checks                                           | Digest push and voice bubble pass on a phone; Play Console forms filed                                  | M    | owner                         | #60, #138 |
| P6  | Recheck the synthetic PostHog events                         | Count is 0; #67, #46, #54 closed                                                                        | S    | owner                         | #67       |
| P7  | Turn on Dependabot alerts; add a landing CSP and domain      | Alerts enabled; CSP header served                                                                       | S    | owner, agent                  | ADR 0010  |

P1 and P2 should finish before real shops are invited.

### M6. Housekeeping

| ID  | Task                         | Acceptance criteria                                                                                                                                               | Size | Who                                 |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------- |
| H2  | Bring docs in line           | `data-model.md` lists every migrated table; finished specs say Done; `quick-enroll-handoff.md` removed or archived; test-URL references explain the ephemeral env | M    | agent                               |
| H3  | Update the PRD scope         | PRD lists debts, assistant, voice, digest, receipts as in or out of MVP                                                                                           | S    | owner decides, agent writes         |
| H4  | Clean worktrees and branches | `git worktree list` shows only active work; merged remote branches deleted; shared cargo target untouched                                                         | S    | agent, owner confirms unmerged ones |

### Later

| ID  | Task                                                   | Needs                                |
| --- | ------------------------------------------------------ | ------------------------------------ |
| L1  | iOS build, iOS push, iOS voice entry points (#53, #74) | Apple developer account              |
| L2  | Cost phase B (B0 spike first)                          | Owner decision                       |
| L3  | Voice donation withdrawal                              | Issue to be written                  |
| L4  | Automatic transfer confirmation (S9)                   | Bank or payment provider integration |

## 5. Order

1. M0 (U1 first; U3 and U5 in parallel; U4 and U6 after decisions).
2. M1 and M3's small tasks (O1, O3, O5) in parallel: they do not touch navigation.
3. X1, then the rest of M2; O4 after X5.
4. M4 runs alongside from the start for R5 (data collection is the long pole); R1 can start any time.
5. M5 owner items in any order; P1 and P2 before real users.
6. M6 at the end, H4 any time.

## 6. Owner decisions

| ID  | Decision                                                        | Recommendation                                                                  |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| D1  | Should a failed test deploy stop production?                    | Yes: turn off Railway auto-deploy for the backend and let `deploy.yml` promote. |
| D2  | What backend do preview APKs use?                               | A hold command for the test env; production with a test store is the fallback.  |
| D3  | Keep or cut top-products, recognition report, price-list export | Show top-products on the Dashboard; cut the other two from the app for now.     |
| D4  | Final navigation                                                | Approve the X1 note.                                                            |
| D5  | Elder mode default for new stores                               | Ask in onboarding, default on.                                                  |
| D6  | Raise Android `minSdk` to 26                                    | Accept: needed by the native camera work.                                       |
| D7  | GPU worker: tunnel or drop                                      | Decide after R5 shows whether the larger embedder is needed.                    |
| D8  | PRD scope for features built beyond section 5                   | Record them as in scope; they are built and tested.                             |
