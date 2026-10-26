# X8 · Push notifications and daily digest: plan

Status: In progress · Date: 2026-10-26 · Branch `epic/x8-push-digest` · Program: [README](README.md) ·
Epic brief: [epics.md](epics.md#x8--push-notifications-and-daily-digest) · Contract: `docs/api/openapi.yaml`
(`GET /v1/assistant/digest`, `POST /v1/devices`, `DELETE /v1/devices/{token}`, schemas `Digest`,
`RegisterDevice`, `Device`).

## Docs checked (2026-10-26)

- Installed `expo-notifications`: `~58.1.6` (Expo SDK 58 compatible).
- Expo SDK 58 `expo-notifications`: Android 13+ shows the permission prompt only after a channel
  exists, so `setNotificationChannelAsync` runs before `getExpoPushTokenAsync({ projectId })`;
  `projectId` comes from `Constants.expoConfig.extra.eas.projectId`. Remote notifications need a
  development or preview build (not Expo Go). Config plugin keys: `icon`, `color`, `defaultChannel`.
  Deep links: `getLastNotificationResponse()` on start plus `addNotificationResponseReceivedListener`,
  then `clearLastNotificationResponse()`.
- Expo Push Service HTTP API: `POST https://exp.host/--/api/v2/push/send` with up to 100 messages,
  tickets `{status: ok, id}` or `{status: error, details: {error}}`; receipts via
  `POST .../push/getReceipts` with up to 1000 ids, checked about 15 minutes later, kept 24 hours.
  `DeviceNotRegistered` (ticket or receipt) means stop sending to that token. Retry 429 and 5xx with
  backoff. Optional `Authorization: Bearer <EXPO_ACCESS_TOKEN>` when enhanced push security is on.
- FCM V1: service account key uploaded to EAS (done by the owner); `google-services.json` is
  committable and referenced by `expo.android.googleServicesFile`.

## Decisions

- **Business date of a digest** is the morning it is shown (today in `Asia/Ho_Chi_Minh`). Its
  content covers yesterday: revenue, sale count, gross profit, change versus the day before
  yesterday, the restock plan, overdue debts and open drafts (draft receipts plus proposed actions).
- **One generation per store per day**, cached in `assistant_digests` keyed by
  `(store_id, business_date)`. The job runs the X3 read tools (`get_sales_summary`,
  `get_restock_plan`) and the debt summary query as a synthetic Lead actor of the store, then makes
  at most one `ChatModel::chat` call with no tools to write `summary_vi`. Any model error, quota
  exhaustion (`quota::openrouter_exhausted`), an empty answer or a summary that leaks a cost or
  profit figure falls back to the Vietnamese template. `source` records `model` or `template`.
- **Permission masking at read time:** the stored payload holds Lead-visible numbers; the GET
  handler nulls `gross_profit`, `unit_cost` and `total_cost` for members without
  `Action::ChangePrice`. The summary never quotes profit or cost amounts (prompt rule plus a check),
  so one summary serves every role.
- **Read state** is per member in `assistant_digest_reads`; the first `GET` of a digest by a member
  sets `read_at`. The `digest` next-step chip appears while today's digest exists and the caller has
  no read row; it navigates to `/digest`.
- **Schedule:** a background task sleeps until the next 07:00 `Asia/Ho_Chi_Minh` (`DIGEST_SEND_AT`
  overrides the time), generates digests for active stores (a sale, a device registration or a
  member sign-in in the last 30 days), pushes to every registered device of the store, then checks
  receipts 15 minutes later. On startup it catches up: if today's send time has passed and a store
  has no pushed digest for today, it generates and pushes once (`assistant_digests.pushed_at`
  prevents duplicates across restarts). `GET /v1/assistant/digest` without a stored digest for today
  generates it on demand through the same code path, so a store never sees a 404 for today.
- **Devices:** `devices` keyed by token; `POST` upserts the caller's store and member onto the
  token (a shared phone follows the latest sign-in); `DELETE` is idempotent and scoped to the
  caller. Push tickets are stored in `push_tickets`; `DeviceNotRegistered` in a ticket or a
  receipt deletes the device; other errors are logged with `taphoa.job.name`.
- **Push payload:** title `Tóm tắt sáng nay`, body = first sentence of `summary_vi`, `data.url =
/digest?entry=push`, `channelId = digest`, `priority = high`, `sound = default`.
- **Quota guard:** `DIGEST_MODEL_MAX_PER_DAY` (default 200) caps model calls per day across stores;
  beyond it, stores get the template. Unit and integration tests use the scripted or a mock model.
- **Mobile prompt timing:** the permission prompt shows on the dashboard on the second signed-in
  app open (never on the first launch), once; a denied answer is not asked again (Android settings
  handle it). Token registration repeats on every signed-in start when permission is granted
  (upsert keeps `app_version` and `language` fresh). Sign-out deletes the token best-effort.
- **Routes:** `/digest` (full digest screen, "Hỏi trợ lý" opens the assistant at `/assistant` from
  X4 with `entry=digest`); dashboard shows `DigestCard` above `DebtCard`. Web gets no push code
  path (`Platform.OS === 'web'` guard) but renders the card and screen.

## Data model (migrations `10xx`)

- `1001_devices.sql`: `devices(token TEXT PRIMARY KEY, store_id UUID NOT NULL REFERENCES stores
ON DELETE CASCADE, member_id UUID NOT NULL REFERENCES members ON DELETE CASCADE, platform TEXT
CHECK (platform IN ('android','ios')), app_version TEXT NOT NULL, language TEXT CHECK (language
IN ('vi','en')), created_at, updated_at)`, index `(store_id, member_id)`;
  `push_tickets(id UUID PRIMARY KEY, store_id, token TEXT NOT NULL, business_date DATE NOT NULL,
ticket_id TEXT, status TEXT CHECK (status IN ('ok','error','pending_receipt','receipt_ok',
'receipt_error')), error_code TEXT, created_at, checked_at)`, index `(status, created_at)`.
- `1002_assistant_digests.sql`: `assistant_digests(store_id, business_date, generated_at,
source TEXT CHECK (source IN ('model','template')), model TEXT, summary_vi TEXT NOT NULL,
payload JSONB NOT NULL, pushed_at TIMESTAMPTZ, PRIMARY KEY (store_id, business_date))`;
  `assistant_digest_reads(store_id, business_date, member_id, read_at, PRIMARY KEY (store_id,
business_date, member_id))` with the digest foreign key cascading.

## Variables

| Name                       | Default                           | Where                                     |
| -------------------------- | --------------------------------- | ----------------------------------------- |
| `EXPO_PUSH_URL`            | `https://exp.host/--/api/v2/push` | `.env.example`; tests point at a mock     |
| `EXPO_ACCESS_TOKEN`        | unset                             | Railway `preserve()`; optional            |
| `DIGEST_SEND_AT`           | `07:00`                           | `.env.example`, Railway (test may differ) |
| `DIGEST_MODEL_MAX_PER_DAY` | `200`                             | `.env.example`, Railway                   |
| `DIGEST_ENABLED`           | `1`                               | `0` disables the scheduler (local runs)   |

## Tasks and worker briefs

Each worker runs in its own superorchestrator worktree with
`CARGO_TARGET_DIR=/media/storage/cache/x8-<task>` and lands failing tests first.

| #   | Task                                                                                     | Owns                                                                                                                                                                 | Tests                                                                                                    |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| T1  | Devices module, `1001` migration, Expo push sender with tickets, receipts, token cleanup | `apps/backend/crates/api/src/devices/**`, `src/push/**`, `migrations/1001_devices.sql`, router merge, `.env.example`, `.railway/railway.ts`                          | `tests/devices.rs`, `tests/push.rs` (mock Expo API over a local axum server), `tests/migrations.rs` rows |
| T2  | Digest generation, template fallback, cache, `GET /v1/assistant/digest`, `digest` chip   | `src/assistant/digest/**` (`mod.rs`, `generate.rs`, `template.rs`, `prompt.vi.md`), `migrations/1002_assistant_digests.sql`, `next_steps/digest.rs`, router routes   | `tests/assistant_digest.rs` (scripted model and mock `ChatModel`), unit tests for template and masking   |
| T3  | Scheduler: 07:00 job, catch-up, push wiring, receipts pass, `main.rs` spawn, variables   | `src/assistant/digest/job.rs`, `main.rs`, `config.rs` additions                                                                                                      | `tests/digest_job.rs` (next-run computation, one push per store per day, receipt cleanup)                |
| T4  | Mobile push: `expo-notifications`, channel, prompt timing, token registration, deep link | `apps/mobile/src/lib/notifications/**`, `app.json`, `google-services.json`, root `_layout.tsx`, `(shop)/_layout.tsx`, `src/lib/api/devices.ts`, hooks/keys additions | Jest: `notifications.test.ts`, `promptTiming.test.ts`, `devices.test.ts`, layout observer test           |
| T5  | Mobile digest card and screen, analytics `digest_opened`                                 | `src/features/digest/**`, `src/app/digest.tsx`, `DashboardScreen.tsx` (card slot), `src/lib/api/digest.ts`, strings                                                  | Jest: `DigestCard.test.tsx`, `DigestScreen.test.tsx`, hook test                                          |
| T6  | E2E: `packages/e2e/tests/devices.test.ts`, digest in `assistant.test.ts`, docs           | `packages/e2e/tests/**`, `docs/specs/assistant/x8-plan.md` results                                                                                                   | Vitest e2e on the branch deploy to `test`                                                                |

Order: T1 ∥ T2 ∥ T4 ∥ T5, then T3 (needs T1 and T2), then T6 (after rebasing on X1 if merged).

## Acceptance (from the X8 brief)

- Rust tests: scheduling (next 07:00 across DST-free `Asia/Ho_Chi_Minh`, catch-up once), caching
  (second generation is a no-op, `source` kept), fallback (model error and quota give `template`),
  receipt handling (`DeviceNotRegistered` deletes the device, `ok` marks `receipt_ok`), all with a
  mock push API and a mock model.
- Jest: registration (channel before token, upsert call, no-op on web and when denied), prompt
  timing, card rendering (loading, ready, read state), deep link to `/digest`.
- `ci-ok` green on the PR; `gh workflow run deploy.yml -f ref=epic/x8-push-digest` passes e2e.
- On Railway `test`: a digest row exists for the store of a registered Android preview build, and
  its `push_tickets` row reaches `receipt_ok`.

## Verification log

Filled in as work lands: commands run, Railway `test` evidence, PR link.

- 2026-10-26 T3 (from `apps/backend`, `CARGO_TARGET_DIR=/media/storage/cache/x8-t3`, `CARGO_BUILD_JOBS=2`; integrations use the supplied local service URLs and `RUST_TEST_THREADS=1`): `cargo fmt --check` PASS; `cargo clippy --locked --all-targets -- -D warnings` PASS; `cargo test -p taphoa-api --lib` PASS (230 passed, 4 ignored); `cargo test -p taphoa-api --test digest_job --test push --test assistant_digest -- --ignored` PASS (digest_job 9, push 7, assistant_digest 7; 23 passed, 0 failed).

- 2026-10-26 backend review fixes (from `apps/backend`, shared X8 Cargo cache and supplied local Postgres/Redis; regressions confirmed RED before fixes): `cargo fmt --check` PASS; `cargo clippy --locked --all-targets -- -D warnings` PASS; `cargo test -p taphoa-api --lib` PASS (231 passed, 4 ignored); `RUST_TEST_THREADS=1 cargo test -p taphoa-api --test devices --test push --test assistant_digest --test digest_job --test assistant_next_steps --test migrations -- --include-ignored` PASS (55 passed: devices 5, push 9, assistant_digest 10, digest_job 12, assistant_next_steps 6, migrations 13; 0 failed, 0 ignored).
