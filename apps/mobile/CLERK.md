# Clerk integration

Set `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` when building the app. A missing key renders
`auth-configuration-error`. Keys must never be committed. Clerk owns credentials
and its secure token cache; `taphoa-current-store` stores only the selected store
IDs keyed by Clerk user ID. `/v1/me` owns the membership and permission data.

The root gate waits for Clerk and preference hydration, then routes signed-out
users to `/sign-in`, users without memberships to `/welcome`, and members to `/`.
Changing users or stores clears shop queries, cart and stock alerts. Store IDs
that no longer belong to the user fall back to the first active membership.

Google uses `useSSO` and activates `createdSessionId` with the returned `setActive`.
Native uses the `taphoa://sign-in` callback. Web uses the exported `/sign-in` page
on the current origin and `maybeCompleteAuthSession` to complete the browser popup.
Register the matching callback URLs in Clerk. Email uses the Core 3 `create`,
`emailCode` / `verifications` and `finalize` resources. The web sign-in page has a
`clerk-captcha` container for instances with legacy bot sign-up protection.

The custom email/browser SSO flows require no Clerk config plugin. Native UI,
native Google SDK sign-in and hosted auth are separate flows.

Verified against the current [Expo quickstart](https://clerk.com/docs/expo/getting-started/quickstart),
[email-code custom flow](https://clerk.com/docs/expo/guides/development/custom-flows/authentication/email-sms-otp),
[OAuth custom flow](https://clerk.com/docs/expo/guides/development/custom-flows/authentication/oauth-connections)
and [`useSSO` reference](https://clerk.com/docs/expo/reference/native-hooks/use-sso).
The installed 4.14.1 declarations confirm the provider/token cache, Core 3
email methods and `finalize`, `reset`, `getToken({ skipCache: true })`, SSO's
`createdSessionId`/`setActive`, and `signOut({ sessionId })` signatures. SDK 58
reference: <https://docs.expo.dev/versions/v58.0.0/>.

`AuthGate` registers the module bridge used by HTTP calls. Store requests carry
`X-Store-Id`; bearer tokens come from Clerk. A token 401 is replayed once using
`getToken({ skipCache: true })`. A second 401 returns to the caller. Wrong-PIN
responses are not replayed, so one user action cannot consume two PIN attempts.
`membership_required` invalidates the current user's `/me` query.

`useMembership` exposes the selected store/member, including role, can_enroll and
has_pin. `useCurrentSessionSignOut` passes `{ sessionId }` to Clerk and then
activates the next signed-in person (see Multi-session below).

## Multi-session switcher and PIN lock (T6)

Multi-session must be on in the Clerk dashboard. The account tab shows
"Người dùng trên máy này": every `useSessionList().sessions` entry with
`status === 'active'` (`client.sessions` also keeps ended, removed and pending
sessions). Each other person's name comes from `GET /v1/me` fetched with that
session's own `session.getToken()` (cached per session with React Query under
`['api', 'device-me', sessionId]`); the current person reuses the app's `/me`.
The name is `profile.display_name`, else the Clerk email, else "Người dùng".

Switching: the target's `/me` is re-read on every tap (never trust a cached
`has_pin`). The target's store is `currentStore.storeIds[<their Clerk user id>]`
or their first membership. Without a PIN (or without any store) `setActive({ session })`
runs at once. With a PIN the account PIN sheet opens and `POST /v1/me/pin/verify`
is sent with the **target** session's token and `X-Store-Id` of that store
(`src/features/auth/sessionApi.ts`, a one-off client beside the active one; one 401
replay with `getToken({ skipCache: true })`, never for `invalid_pin`). Only 204 calls
`setActive`. 401 `invalid_pin` shows "Sai mã PIN" and clears the digits; 429 shows
the lockout with the `Retry-After` wait ("5 phút" / "45 giây"); any other failure
shows a retry message. If `/me` cannot be read nobody is switched.

"Thêm người trên máy này" pushes `/add-person` (`src/app/add-person/*`), which
reuses `SignInScreen` and `VerifyCodeScreen` with `flow="add"` and never signs
anyone out. The route is not declared in the root `Stack.Protected` groups, so it
stays reachable while signed in. When the new session is finalized AuthGate swaps
to its loading view and rebuilds the stack around the new person, so the add routes
do not navigate during that: `AddPersonLayout` remembers the session that was active
when the flow began (`useAddPerson`) and redirects to `/` once a different one is,
and the root gate then picks the shop or `/welcome`. Cancel resets the sign-in
attempt and `dismissTo('/account')`. Google's callback in this mode is
`taphoa://add-person` (web: `<origin>/add-person`), because the callback route must
render while signed in; register it next to the `sign-in` callback in Clerk.

Sign out passes `{ sessionId }` of the current session. Checked in clerk-js 6.40.1
(`@clerk/expo` 4.14.1): with several signed-in sessions it removes only that one and
leaves **no** session active (clerk-js reselects one only when it loads), so the
hook calls `setActive({ session })` for the first remaining signed-in person right
after. That hand-over has no PIN check by design of the task; a stricter product
rule would route it through the switch sheet instead.

Store picker: with more than one membership a "Cửa hàng" list appears; choosing one
calls `selectStore(<Clerk user id>, <store id>)`. `AuthGate` keys its identity on
`<user id>:<store id>`, so both a person switch and a store switch run the existing
cache-clearing effect (queries, cart, low-stock alerts), and the next request carries
the new `X-Store-Id`.

T6 files: `src/features/account/{DeviceSessions,SwitchPinSheet,StorePicker}.tsx`,
`useSwitchSession.ts` (plus `PinSheet` ids and `clearKey`), `src/features/auth/{sessionApi,
deviceSessions,addPerson}.ts`, `AddPersonLayout.tsx`, `src/app/add-person/*`, and the
`flow="add"` mode of `SignInScreen` / `VerifyCodeScreen`.

Stable test IDs: `account-sessions`, `account-session-<index>` (position in the
signed-in list, Clerk order), `account-sessions-error`, `account-add-person`,
`account-switch-pin` with parts `-dots`, `-error`, `-keypad`, `-submit`,
`account-stores`, `account-store-<storeId>`, `auth-add-cancel` (add mode of both
auth screens). The generic `PinSheet` uses `pin-sheet` and the same parts by default.

## Dependencies

- `@clerk/expo` 4.14.1
- `expo-auth-session` 58.0.14
- `expo-web-browser` 58.0.6
- `expo-crypto` 58.0.7

Installed with `npx expo install`. `expo-secure-store` 58.0.2 was already present.
`expo install --fix` aligned the existing SDK 58 patch versions to make
`expo-doctor` clean: Expo 58.0.19; Router 58.0.26; dev client 58.0.15; file system
58.0.11; font 58.0.10; image 58.0.17; React/React DOM 19.3.0; FlashList 2.3.2;
TypeScript 6.0.3. No major SDK change. `pnpm-workspace.yaml` explicitly denies
the transitive `browser-tabs-lock` and `core-js` build scripts.

## Routes and stable test IDs

| Route             | Screen                      | Inputs and actions                                                                                                               |
| ----------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `/sign-in`        | `auth-sign-in-screen`       | `auth-email`, `auth-send-code`, `auth-google`, `auth-captcha` (web)                                                              |
| `/verify-code`    | `auth-code-screen`          | `auth-code`, `auth-verify-code`, `auth-resend-code`, `auth-change-email`                                                         |
| `/welcome`        | `onboarding-welcome-screen` | `onboarding-create`, `onboarding-join`, `onboarding-sign-out`                                                                    |
| `/create`         | `create-store-screen`       | `create-store-name`, `create-display-name`, `create-bank-bin`, `create-bank-number`, `create-bank-holder`, `create-store-submit` |
| `/join?token=...` | `join-store-screen`         | `join-invite-token`, `join-display-name`, `join-store-submit`                                                                    |
| `/account`        | Existing account screen     | `account-sign-out`, `account-sessions`, `account-session-<index>`, `account-add-person`, `account-store-<storeId>`               |
| `/add-person`     | `auth-sign-in-screen`       | `auth-email`, `auth-send-code`, `auth-google`, `auth-add-cancel`; then `/add-person/verify-code` (`auth-code-screen`)            |

`taphoa://join?token=...` remains supported. Invitations opened while signed out
are kept in memory through sign-in and prefill the join form. `/recover` and
`/recovery-code` are removed. The Playwright web suite is described in
[Playwright web e2e](#playwright-web-e2e); the Maestro suite belongs to a later task.

## Jest support

`src/test/clerk.ts` provides controllable Clerk auth/session state, `getToken`,
`signIn`/`signUp` resources, SSO, activation and sign-out. `src/test/session.ts`
provides membership fixtures; it contains no credentials. Screen providers resolve
`/me` before mounting shop UI, matching the root gate. The mock API implements
Clerk create/join/me and PIN endpoints and contract tests validate their responses.

For several people, `addClerkSession()` adds a session with its own `getToken`
(`token_<id>`); `setActive` switches the mocked user and `signOut({ sessionId })`
removes only that session and leaves nobody active, like clerk-js. `src/test/people.ts`
stands in for the network other people's sessions use: it keys `/v1/me` and
`/v1/me/pin/verify` by bearer token and records token, `X-Store-Id` and body.

## Playwright web e2e

`e2e-web/` drives the real web export against the real backend and the real Clerk
**development** instance. Checked against the current
[Playwright overview](https://clerk.com/docs/guides/development/testing/playwright/overview),
[test helpers](https://clerk.com/docs/guides/development/testing/playwright/test-helpers)
and the installed `@clerk/testing` 2.2.50 declarations (`clerkSetup`,
`setupClerkTestingToken`, `clerk.signIn`).

Environment, exported in the shell that runs Playwright (never written to a file, a log or
a commit): `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` of the instance the backend
verifies against. The backend must run with the same `CLERK_PUBLISHABLE_KEY`;
`playwright.config.ts` passes it to the export as `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (public
by design) and `global-setup.ts` stops the run with the fix in the message when either key
or the backend is missing.

- `global-setup.ts`: `clerkSetup()` fetches the testing token (`CLERK_TESTING_TOKEN`,
  `CLERK_FAPI` in `process.env`, inherited by the workers). It also creates a tracking
  directory: `@taphoa/e2e/clerk` (`packages/e2e/src/clerk.ts`) appends the id of every user
  it creates, and the teardown deletes them all even after failed specs. A failed deletion
  warns and leaves the ids; `pnpm --filter @taphoa/e2e clerk:sweep` removes `+clerk_test`
  users older than 24 h.
- `fixtures.ts`: `store` is a new Clerk user (Backend API: user, session, one 1 h session
  token) who is the Lead of a new store (`POST /v1/stores` with that bearer). `page` starts
  signed in as that user: `setupClerkTestingToken({ page })`, open `/sign-in` (unprotected, so
  Clerk loads) and `clerk.signIn({ page, emailAddress })`, which redeems a Backend API
  sign-in token in the page: no typing, the app then runs its own Clerk session and sends
  its own bearer and `X-Store-Id`. Specs that cover the sign-in screens use
  `test.use({ signedIn: false })`. Other users: `createNewcomer()` (no store),
  `joinStoreViaApi(lead)` (seller), `signInAs(page, user)` and `openSignedInPhone(browser,
baseURL, user)` (a second browser).
- Sign-in through the screens uses a `+clerk_test` address and the code `424242`
  (`TEST_CODE`). `onboarding.spec.ts` covers the signed-out redirect, a user without a store
  creating one, a returning member, a Lead's invite, joining from an invite link opened
  while signed out, and "Đăng xuất". `account.spec.ts` checks that "Đăng xuất" ends only
  this phone's session. The multi-session switcher and its PIN lock are not covered here.
- Limits: the Frontend API allows 5 sign-ins and 3 first-factor attempts per 10 s per IP,
  the Backend API 100 requests per 10 s for every holder of the secret key (Railway
  environments, seed and CI share it). CI keeps 2 workers; the Backend API helper queues
  requests below 8 per second and honours `Retry-After`; `signInPage` and the screen
  helpers back off and retry on rate limits. Locally prefer `--workers=2`.
- A brand-new address signs up with email code only. While the dashboard requires another
  attribute at sign-up (it requires a password today), Clerk leaves the sign-up in
  `missing_requirements` and the app shows "Tài khoản cần thêm bước xác minh". Global setup
  reads `/v1/environment`, warns, and the spec of that path skips itself with the list as
  the reason; it runs by itself once the dashboard makes the attribute optional (or the app
  supplies it).

Run (the stack script is owned by the CI task; start the backend with the Clerk keys, then):

```bash
export CLERK_PUBLISHABLE_KEY=... CLERK_SECRET_KEY=...   # from your secrets store
pnpm --filter @taphoa/mobile test:e2e:web -- --project=chromium --workers=2
```

## File inventory

Added:

- `CLERK.md`
- `src/app/(auth)/_layout.tsx`
- `src/app/(auth)/sign-in.tsx`
- `src/app/(auth)/verify-code.tsx`
- `src/features/auth/AuthGate.test.tsx`
- `src/features/auth/AuthGate.tsx`
- `src/features/auth/ConfigurationError.tsx`
- `src/features/auth/SignInScreen.tsx`
- `src/features/auth/VerifyCodeScreen.tsx`
- `src/features/auth/emailFlow.ts`
- `src/features/auth/errors.test.ts`
- `src/features/auth/errors.ts`
- `src/features/auth/flows.test.tsx`
- `src/features/auth/strings.ts`
- `src/features/auth/useCurrentSessionSignOut.ts`
- `src/features/auth/useMembership.ts`
- `src/features/onboarding/CreateStoreScreen.test.tsx`
- `src/features/onboarding/JoinStoreScreen.test.tsx`
- `src/features/onboarding/inviteIntent.ts`
- `src/features/onboarding/useCompleteOnboarding.ts`
- `src/lib/api/authFetch.extra.test.ts`
- `src/lib/api/clerkBridge.test.ts`
- `src/lib/api/clerkBridge.ts`
- `src/stores/currentStore.test.ts`
- `src/stores/currentStore.ts`
- `src/test/clerk.ts`
- `src/test/mock/auth.test.ts`
- `src/test/mock/auth.ts`

Removed:

- `src/app/(onboarding)/recover.tsx`
- `src/app/(onboarding)/recovery-code.tsx`
- `src/features/onboarding/RecoverStoreScreen.tsx`
- `src/features/onboarding/RecoveryCodeScreen.tsx`
- `src/lib/api/auth.test.ts`
- `src/lib/api/auth.ts`
- `src/stores/session.test.ts`
- `src/stores/session.ts`
- `src/stores/sessionStorage.ts`

Existing files updated include the root layout, onboarding/account screens and
strings, all five permission consumers (camera, dashboard, alerts, expense,
product), API client/hooks/keys/store, mock routes/fixtures, test providers and
consumer/contract/flow tests, package manifest, lockfile and bundle budget.

## Acceptance evidence

All requested checks pass: mobile lint, typecheck, `test:coverage`, Android and
web exports, `build:all` (also iOS), `check:bundle`, `expo-doctor` (20/20), and
`pnpm exec prettier --check apps/mobile` from the repository root.

Jest: 119 suites, 991 tests; statements 97.82%, branches 92.67%, functions 97.66%,
lines 98.73%. The coverage command also runs 329 tests under each of four
time-zone/clock combinations and 13 script tests. The global coverage thresholds
remain 90/90/90/85. Test-first failure logs from the initial implementation were
retained in `/tmp/t4-red-*.log`; final verification logs use
`/tmp/t4-resume-*.log`. Final checks run on the repository's Node 24 runtime.

| Bundle              | Before Clerk | Final      | Budget change                 |
| ------------------- | ------------ | ---------- | ----------------------------- |
| Android, raw Hermes | 7417.3 KiB   | 9123.0 KiB | 8,650,000 to 10,750,000 bytes |
| Web, gzip all JS    | 902.2 KiB    | 1001.0 KiB | Unchanged at 1,045,000 bytes  |

The baseline is the pre-Clerk export recorded by the previous account in
`/tmp/t4-baseline-bundle.log`, before the SDK patch alignment above. Final exact
sizes are Android 9,341,973 bytes, web 1,025,007 bytes (26 chunks), and iOS
9,354,900 bytes. The Android budget increase is committed with the Clerk imports
that cause it, preserving roughly 15% headroom. Web remains within its existing
budget.

Validation uses the contract and in-memory backend. Hosted Clerk authentication,
Playwright and Maestro remain for T7/T10. No backend, shared API contract,
Playwright or Maestro files were changed. No keys were added. The task branch is
committed locally without a push; its unmerged worktree is retained for the epic
controller.
