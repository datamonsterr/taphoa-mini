# Clerk identity: integration contract and migration

Status: Accepted · Date: 2026-10-25 · Program: [README](README.md) · ADR
[0004](../../adr/0004-clerk-identity.md) · Epic: X1

## Instance

- Clerk development instance `ins_3LAw2tiYcdkY9D144FXok8V3Emw`, Frontend API
  `full-moccasin-5407.clerk.accounts.dev`, JWKS
  `https://full-moccasin-5407.clerk.accounts.dev/.well-known/jwks.json`.
- Enabled now: email verification code, Google, password (unused by our screens), Facebook
  (unused). Pending user toggle: multi-session (single-session mode is on).
- Keys: `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are set on the Railway backend in `test`
  and `production`; `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` is set in EAS (all environments);
  local copies are in `~/.config/taphoa-mini/secrets.env`.

## Backend

- **Verification:** every protected route takes `Authorization: Bearer <Clerk session JWT>`.
  Verify RS256 with the JWKS (cache, refetch on unknown `kid`, at most once per minute), `exp`
  and `nbf` with 5 s leeway, `iss` equal to `https://<frontend api>`, `azp` in
  `CLERK_AUTHORIZED_PARTIES` when present, and reject pending sessions. Check the current
  Clerk session-token claim docs before coding (token version, `sid`, `sts`).
- **Store selection:** `X-Store-Id` header. Required when the Clerk user has more than one
  membership; optional with exactly one. Wrong or foreign store gives 403.
- **Actor:** `{clerk_user_id, member_id, store_id, clerk_session_id, role, can_enroll}`. The
  extractor records `user.id`, `taphoa.store.id`, `taphoa.member.id` and
  `taphoa.member.role` on the current span (telemetry contract).
- **Profile:** display name and email come from the Clerk Backend API (`GET /v1/users/{id}`),
  cached in Redis for 10 minutes, used only for defaults and PostHog person properties sent by
  the app. Never in span or log attributes.
- **Webhooks:** not used. Membership lives in our DB; profile reads are lazy.
- **New permission actions:** `RecordDebt` (all members) and `AdjustDebt` (Lead) are added by X5.

## API changes (X1 edits `docs/api/openapi.yaml`)

| Operation                                                 | Change                                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `createStore`                                             | Clerk JWT required, no member yet; body `{store_name, display_name, bank_account?}`; no recovery code, no device |
| `joinStore`                                               | Clerk JWT + `{invite_code, display_name}`; one membership per Clerk user per store                               |
| `getMe`                                                   | Clerk user id, memberships `[{store, member}]`                                                                   |
| `setPin`                                                  | kept; plus `POST /v1/me/pin/verify` (rate limited) for the PIN lock                                              |
| `recoverLead`, `refreshSession`, `switchMember`, `logout` | removed                                                                                                          |
| security scheme                                           | `bearerAuth` description changes to Clerk session JWT; `X-Store-Id` header parameter                             |

## Data migration (`0701_clerk_identity.sql`)

- Store-scoped data is reset (owner decision R5, 2026-10-25): truncate store data, then alter the
  schema. On a fresh database the truncate is a no-op.
- `members.clerk_user_id TEXT NOT NULL`, unique `(store_id, clerk_user_id)`.
- Drop `sessions`, recovery-code columns and lookups. `sales.session_id` becomes
  `clerk_session_id TEXT NULL` (no foreign key).
- Remove `JWT_SECRET` usage from code; keep the Railway variable until the release is live,
  then delete it in `.railway/railway.ts`.
- Delete orphan images in the bucket after the reset (one-off script, both environments).

## Mobile

- Check the current Clerk Expo SDK package and APIs before coding (package name, provider,
  token cache, SSO hook, multi-session hooks).
- `ClerkProvider` at the root with a `expo-secure-store` token cache. Gate in `_layout`:
  signed out goes to sign-in; signed in without membership goes to onboarding (create store or
  join with code); with a membership goes to the shop.
- Own Vietnamese screens (design system, `vi` and `en`): email address then 6-digit code;
  "Tiếp tục với Google". No Clerk prebuilt UI.
- Multi-session: account tab lists signed-in people on this device, "Thêm người trên máy này",
  switch with PIN lock first. Sign out removes only the current session.
- API client: `Authorization: Bearer <await getToken()>` and `X-Store-Id` on every call; a 401
  retries once with a fresh token.
- Remove recovery-code screens, `recover`, refresh logic and the old session store.

## Tests

- Rust: JWT verification unit tests with a local RSA key and JWKS stub (expired, wrong `iss`,
  wrong `azp`, unknown `kid` refetch, pending session); Actor resolution with 0, 1 and 2
  memberships; permission matrix unchanged.
- E2E harness (`packages/e2e/src/helpers.ts`): `createStore` and `joinAsSeller` create Clerk
  users through the Backend API with `+clerk_test` emails, create a session and mint session
  tokens (refresh before the 60 s expiry). All module specs keep calling the helpers.
- Playwright web: Clerk testing tokens; sign in with a `+clerk_test` email and code `424242`.
- Maestro Android: the same test email and code; multi-session switch with PIN.
- `taphoa-seed` creates or reuses Clerk test users for seed and eval stores (idempotent by
  email) and links members.
- GitHub secrets for CI: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` (`gh secret set`).
