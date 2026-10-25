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

## Maestro (Android)

The flows in `.maestro/` sign in through the real screens (email, then code) against the Clerk
development instance and the real backend. CI (`.github/workflows/android-e2e.yml`) runs them on a
release APK built with `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`; the backend started by
`scripts/e2e/stack.sh` gets the `CLERK_*` keys. Every flow starts with `subflows/launch.yaml`
(fresh state, camera permission, waits for `auth-email`), `subflows/sign-in.yaml` and
`subflows/create-store.yaml`.

- `sign-in.yaml` makes `e2e-maestro-<timestamp><random>+clerk_test@example.com`, types it in
  `auth-email`, presses Enter, types `424242` in `auth-code`, presses Enter and waits for the
  welcome screen (the camera for an address that already has a store). The optional `EMAIL`
  env reuses an address; `output.email` holds the one used. `+clerk_test` sends no mail. The `e2e-`
  prefix is what the e2e sweep (`packages/e2e/src/sweep.ts`) deletes, so Maestro users do not pile
  up in the instance.
- `create-store.yaml` runs on `/welcome`: `onboarding-create`, `create-store-name`,
  `create-display-name`, Enter. There is no recovery code.
- `open-account.yaml` goes from the camera to the account tab; `scroll-account-end.yaml` scrolls
  that tab so the people list, `account-add-person` and `account-sign-out` clear the floating tab
  bar (a tap on an element just under the bar hits the tab instead).
- `onboarding.yaml` also signs out (`account-sign-out`, back to sign-in) and signs in again with
  the same address, which must land on the camera with the store.
- `multi-session.yaml`: person A signs in, creates a store and sets PIN 2468; `account-add-person`
  (and `auth-add-cancel`, which keeps A signed in) then person B signs in and creates a store; in
  B's account tab the row "Chuyển sang ..." opens the PIN sheet of A; a wrong PIN shows
  "Sai mã PIN" and does not switch, the right one opens A's store; signing out A leaves B signed
  in as the current person; signing out B shows the sign-in screen.
- Clerk's Frontend API allows 5 sign-in creations and 3 attempts per 10 s. A flow signs in once or
  twice, well apart: never loop a sign-in or add a retry around it. Waits for Clerk and backend
  screens use `extendedWaitUntil` with 30 to 90 s.
- Selectors are regular expressions matched against the whole text. Dynamic text with `(`, `)`, `.`
  or `+` (an email, "4-6 digits") needs `.*` or escaping. The PIN digits avoid 5: the account tab
  shows the low-stock threshold (default 5) as a text of its own, so key "5" would be ambiguous.
- `maestro check-syntax <flow>` checks a flow without a device; only the CI run proves it.

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
`/recovery-code` are removed. The Maestro Android flows are described under
Maestro (Android) below.

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
