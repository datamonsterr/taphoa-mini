# X1 · Clerk identity: task graph

Status: In progress · Date: 2026-10-25 · Epic: X1 ([epics.md](epics.md#x1--clerk-identity)) ·
Contract: [auth-clerk.md](auth-clerk.md) · ADR [0004](../../adr/0004-clerk-identity.md) ·
Branch: `epic/x1-auth-clerk`

The epic controller plans, briefs, reviews and merges. Workers edit source. Every task lands
its failing tests first, then code, then its acceptance commands green. Each task merges into
`epic/x1-auth-clerk`; the epic lands as one PR into `main`.

## Vendor facts checked (2026-10-25)

| Topic                | Fact                                                                                                                                                                                                                                                                                                                                                          | Source                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session token claims | v2 claims: `sub` (user id), `sid` (session id), `sts` (session status, `pending` before session tasks finish), `v` = 2, `azp` (Origin of the Frontend API request; absent when no Origin, so tokens minted with the Backend API have none), `iss`, `exp`, `nbf`, `iat`, `jti`, `fva`, optional `o`, `pla`, `fea`, `act`. Header has `kid`, `oiat`.            | clerk.com/docs/guides/sessions/session-tokens                                                                                                                                                                                                                                                                                                   |
| Manual verification  | RS256 against JWKS (`https://<frontend api>/.well-known/jwks.json` or `https://api.clerk.com/v1/jwks`); reject on `exp`/`nbf`; check `azp` against permitted origins when present, skip when absent; reject `sts = pending`.                                                                                                                                  | clerk.com/docs/guides/sessions/manual-jwt-verification                                                                                                                                                                                                                                                                                          |
| Backend API          | `POST /v1/users` (`email_address: [..]`, `first_name`, `last_name`, `skip_password_requirement`), `GET /v1/users?email_address=`, `GET /v1/users/{id}`, `DELETE /v1/users/{id}`, `POST /v1/sessions` (`user_id`; testing only, not on production instances), `POST /v1/sessions/{id}/tokens` (`expires_in_seconds` 30..315360000), `POST /v1/testing_tokens`. | github.com/clerk/openapi-specs `bapi/2026-08-20.yml`                                                                                                                                                                                                                                                                                            |
| Rate limits          | Backend API on a development instance: 100 requests per 10 s for all endpoints, shared by every holder of the secret key (both Railway environments, seed, e2e, CI). Frontend API: create sign-in 5 per 10 s, attempt first factor 3 per 10 s. 429 carries `Retry-After`.                                                                                     | clerk.com/docs/guides/how-clerk-works/system-limits                                                                                                                                                                                                                                                                                             |
| Test identities      | Emails with a `+clerk_test` subaddress verify with code `424242` and send no mail. Testing tokens (`__clerk_testing_token`) bypass bot protection in browser tests.                                                                                                                                                                                           | clerk.com/docs/guides/development/testing/overview                                                                                                                                                                                                                                                                                              |
| Expo SDK             | `@clerk/expo` 4.14.x (Core 3; `@clerk/clerk-expo` is deprecated). Peers: `expo >=54 <59`, `expo-secure-store`, `expo-auth-session`, `expo-web-browser`, `expo-crypto`. `ClerkProvider` from `@clerk/expo`, `tokenCache` from `@clerk/expo/token-cache`. Core 3 hooks: `useSignIn()`/`useSignUp()` return `{signIn                                             | signUp, errors, fetchStatus}`; email code via `signIn.emailCode.sendCode()`/`verifyCode()`, `signUp.verifications.sendEmailCode()`/`verifyEmailCode()`, then `finalize()`. Multi-session: `useClerk()`→`client.sessions`, `setActive({session})`, `signOut({sessionId})`. Workers re-check the exact signatures in the installed package types. | clerk.com/docs/expo/getting-started/quickstart, npm |
| Playwright           | `@clerk/testing` 2.x: `clerkSetup()` in global setup (needs `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`), `setupClerkTestingToken({ page })` before navigation.                                                                                                                                                                                               | clerk.com/docs/guides/development/testing/playwright                                                                                                                                                                                                                                                                                            |

## Decisions (settled for this epic)

These refine [auth-clerk.md](auth-clerk.md); they do not change it.

1. **Configuration.** `CLERK_PUBLISHABLE_KEY` gives the Frontend API host (the key is
   `pk_test_` + base64 of `<host>$`); issuer `https://<host>`, JWKS
   `https://<host>/.well-known/jwks.json`. Optional overrides: `CLERK_ISSUER`, `CLERK_JWKS_URL`
   (tests point them at a local stub), `CLERK_API_URL` (default `https://api.clerk.com`),
   `CLERK_AUTHORIZED_PARTIES` (comma-separated origins). `CLERK_SECRET_KEY` is optional for the
   verifier; without it profile reads return `null`. Startup fails when no issuer can be
   derived. `JWT_SECRET` is no longer read.
2. **Verifier.** RS256 only; JWKS cached in memory; unknown `kid` refetches at most once per
   60 s; `exp`/`nbf` with 5 s leeway; `iss` exact; `azp` must be in `CLERK_AUTHORIZED_PARTIES`
   when both are present; `sts == "pending"` is rejected; `sub` and `sid` required. Every
   failure is `401 unauthorized`.
3. **Extractors.** `ClerkIdentity { user_id, session_id }` (token only, no membership) guards
   `createStore`, `joinStore` and `getMe`. `Actor { clerk_user_id, member_id, store_id,
clerk_session_id, role, can_enroll }` guards every store route: active memberships of the
   Clerk user; `X-Store-Id` selects one. Zero memberships: `403 membership_required`. More
   than one and no header: `400 store_required`. Malformed header: `400 validation_failed`.
   Header naming a store without an active membership: `403 forbidden`. Exactly one and no
   header: that store.
4. **Endpoints.** `POST /v1/stores` `{store_name, display_name, bank_account?}` → `201
{store, member}`. `POST /v1/auth/join` `{invite_token, display_name}` → `201 {store,
member}`; an active membership in that store → `409 already_member`; an inactive one is
   reactivated with the invite's role and `can_enroll`. (The spec's "invite code" is the
   existing invite token; the field keeps the name `invite_token` to match `Invite.token` and
   the join URL.) `GET /v1/me` → `{clerk_user_id, profile: {display_name, email} | null,
memberships: [{store, member}]}` (active memberships only, ordered by join time).
   `PUT /v1/me/pin` unchanged. `POST /v1/me/pin/verify` `{pin}` → `204`; a member without a
   PIN also gets `204`; wrong PIN `401 invalid_pin`; lockout `429` (the existing PIN limiter).
   Removed: `recoverLead`, `refreshSession`, `switchMember`, `logout` and the `AuthSession`
   schema.
5. **Profile.** `GET {CLERK_API_URL}/v1/users/{id}` with the secret key, cached in Redis as
   `clerk:user:<id>` for 600 s; display name = first + last name, else username, else null;
   email = primary email. Any Clerk failure gives `profile: null`, never an error. Never in
   span or log attributes.
6. **Events.** The envelope `actor` becomes `{member_id, session_id}` where `session_id` is the
   Clerk session id string. `session.revoked` is removed from AsyncAPI and code. The event
   stream of a member closes when `member.changed` arrives with `{member_id: <self>, change:
"deactivated"}`; removed members get `403` on the next request because the extractor reads
   active memberships every time.
7. **Migration `0701_clerk_identity.sql`.** Truncate every store-scoped table (stores cascade
   plus any table without a foreign key to `stores`, for example outbox, images, idempotency
   rows), then: `members.clerk_user_id TEXT NOT NULL`, unique `(store_id, clerk_user_id)`,
   index on `clerk_user_id` where active; `sales.session_id` dropped, `sales.clerk_session_id
TEXT NULL` added; `sessions` dropped; `stores.recovery_code_hash` and
   `recovery_code_lookup` dropped. Immutable once deployed to `test`.
8. **Shared `test` database.** Deploying this branch to Railway `test` applies `0701`, after
   which `main` code (still on `sessions`) fails there. So the branch goes to `test` only when
   everything else is green, and the PR merges right after that deploy passes.
9. **E2E harness.** Helpers create a Clerk user per store or seller
   (`e2e-<unique>+clerk_test@example.com`), create a session and mint one session token with
   `expires_in_seconds: 3600` (no refresh timer needed; a `token()` re-mint function stays
   for long specs). A client-side limiter keeps Backend API calls under 8 per second and
   retries 429 after `Retry-After`. Created users are deleted in a global teardown; a sweep
   script deletes `+clerk_test` users older than 24 h. `CreatedStore.session.access_token`
   keeps working so module specs need no change.
10. **Mobile.** `@clerk/expo` with `expo-secure-store` token cache, own screens in `(auth)`:
    email then 6-digit code (sign in, or sign up when the email is new), "Tiếp tục với Google".
    Gate in the root `_layout`: no Clerk session → `(auth)`; session without membership →
    `(onboarding)` (create store or join); membership → shop. The current store id lives in a
    small persisted store keyed by Clerk user id. The api-client gets `getStoreId` next to
    `getToken`; mobile retries a 401 once with `getToken({ skipCache: true })`.
11. **Multi-session switcher.** Account tab lists `client.sessions`; switching to another
    person asks for that person's PIN (verified with their own session token through
    `POST /v1/me/pin/verify`) and then calls `setActive`. "Thêm người trên máy này" opens the
    sign-in screen without signing anyone out. "Đăng xuất" signs out only the current session.
    Multi-session is off in the dashboard today: build and unit-test it; the device flow waits
    for the user's toggle (task T10).

## Task graph

```
T0 contract + api-client ──┬── T2 backend identity ── T5 seed + scripts + CI ──┐
T1 Clerk verifier ─────────┘                                                    │
T0 ─────────────────────────── T3 e2e harness + auth/members specs ────────────┤
T0 ─────────────────────────── T4 mobile Clerk core ─┬─ T6 multi-session + PIN ─┤
                                                     └─ T7 Playwright sign-in ──┤
                               T8 orphan image script (any time) ──────────────┤
                                                                                ▼
          T9 controller: secrets, vars, branch deploy to test, full e2e, review, merge
                               T10 Maestro sign-in + switch (needs multi-session on)
```

| Task | Scope (owned files)                                                                                                                                                                                                                                                             | Tests first                                                                                                                                                                                       | Acceptance                                                                                             | Route                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| T0   | Auth sections of `docs/api/openapi.yaml`, auth parts of `docs/api/asyncapi.yaml`, `packages/api-client/src/{index.ts,index.test.ts,schema.d.ts}` (`getStoreId` option)                                                                                                          | api-client vitest: `X-Store-Id` sent when `getStoreId` returns a value, absent otherwise                                                                                                          | `pnpm lint:api`, `pnpm --filter @taphoa/api-client check:generated test typecheck`                     | codex gpt-6.1-sol medium |
| T1   | New `apps/backend/crates/api/src/auth/clerk.rs` (verifier, JWKS cache, publishable-key parsing), `config.rs` Clerk fields                                                                                                                                                       | Unit tests with a local RSA key and JWKS stub: valid, expired, `nbf` future, leeway, wrong `iss`, wrong `azp`, absent `azp`, unknown `kid` refetch + 60 s throttle, `sts` pending, HS256 rejected | `cargo test -p taphoa-api auth::clerk`, `cargo clippy --all-targets -D warnings`                       | codex gpt-6.1-sol high   |
| T2   | `auth/**`, auth parts of `store/**`, `migrations/0701_clerk_identity.sql`, `events/**` session logic, `sales` session column, every `Actor` constructor, `tests/common/**`, `tests/auth_flow.rs`, `tests/contract.rs`, `tests/asyncapi.rs`, profile client                      | Actor with 0/1/2 memberships and `X-Store-Id` cases; createStore/join/getMe/PIN verify; legacy routes 404; permission matrix unchanged; stream closes on deactivation                             | `cargo nextest run` (unit + integration with Postgres/Redis), clippy, fmt                              | codex gpt-6.1-sol high   |
| T3   | `packages/e2e/src/**` (helpers, Clerk Backend API client, teardown, sweep), `packages/e2e/tests/auth.test.ts`, `tests/members.test.ts`, minimal edits in other specs only where they read removed fields                                                                        | Vitest unit tests for the Clerk client limiter and 429 retry (mock fetch)                                                                                                                         | `pnpm --filter @taphoa/e2e typecheck lint test`; live run against local stack after T2                 | codex gpt-6.1-sol medium |
| T4   | `apps/mobile`: `@clerk/expo` install, root `_layout` provider + gate, `(auth)/**`, `(onboarding)/**`, `features/onboarding/**`, session store replacement, `lib/api` auth wiring, `src/test/mock` auth routes, remove recovery screens                                          | Jest: gate routing (signed out / no membership / membership), sign-in email + code screens, create + join with new API, 401 retry once, store id header                                           | `pnpm --filter @taphoa/mobile lint typecheck test:coverage`, `expo export` web + android, expo-doctor  | codex gpt-6.1-sol high   |
| T5   | `taphoa-seed` Clerk users, `apps/backend/scripts/e2e.sh`, `scripts/e2e/stack.sh`, `docker-compose.yml`, `.github/workflows/{ci,railway-integration,android-e2e}.yml` env, `.railway/railway.ts`, `.env.example` files, auth rows of `docs/architecture.md` and `docs/deploy.md` | Seed idempotency test with a Clerk stub                                                                                                                                                           | `cargo nextest run` seed tests; `actionlint` if present; workflows reference only secrets that exist   | codex gpt-6.1-sol medium |
| T6   | `features/account/**` switcher, PIN lock sheet, sign-out current session                                                                                                                                                                                                        | Jest: list sessions, switch asks PIN and calls `setActive` only after `204`, wrong PIN stays, sign-out passes the current session id                                                              | mobile lint, typecheck, coverage                                                                       | codex gpt-6.1-sol medium |
| T7   | `apps/mobile/e2e-web/**` (`@clerk/testing` setup, fixtures sign in through Clerk, `onboarding.spec.ts` sign-in flow), `playwright.config.ts`                                                                                                                                    | The specs are the tests                                                                                                                                                                           | `pnpm --filter @taphoa/mobile test:e2e:web` green against `scripts/e2e/stack.sh` with the dev instance | codex gpt-6.1-sol high   |
| T8   | `apps/backend/scripts/delete-orphan-images.*` one-off (bucket keys not referenced by `images`)                                                                                                                                                                                  | Dry-run mode test                                                                                                                                                                                 | dry run lists, `--apply` deletes; run once per environment after the reset                             | codex gpt-6.1-sol medium |
| T10  | `apps/mobile/.maestro/**` sign-in subflow with `+clerk_test` email and `424242`, switch flow with PIN                                                                                                                                                                           | The flows are the tests                                                                                                                                                                           | `android-e2e.yml` green                                                                                | codex gpt-6.1-sol medium |

T9 (controller): `gh secret set CLERK_SECRET_KEY CLERK_PUBLISHABLE_KEY` from the local secrets
file; Railway variables unchanged except `CLERK_AUTHORIZED_PARTIES` if web origins need it;
`gh workflow run deploy.yml -f ref=epic/x1-auth-clerk`; full e2e green on `test`; review
(`/code-review` + `cavecrew-reviewer`); merge commit; watch `Deploy backend` to production
smoke; run T8 per environment; clean the worktree.

## Coordination

- X2 adds one call in the `Actor` extractor that records identity attributes; keep it on
  rebase.
- X0 edits other sections of the same OpenAPI file and regenerates `schema.d.ts`; resolve by
  regenerating after rebase.
- Other epics' e2e specs use the helpers only; after this merges they rebase onto `main`.

## Progress

| Task | State   | Notes |
| ---- | ------- | ----- |
| T0   | pending |       |
| T1   | pending |       |
| T2   | pending |       |
| T3   | pending |       |
| T4   | pending |       |
| T5   | pending |       |
| T6   | pending |       |
| T7   | pending |       |
| T8   | pending |       |
| T9   | pending |       |
| T10  | pending |       |
