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
has_pin. `useCurrentSessionSignOut` passes `{ sessionId }` to Clerk. The
`account-sessions` container marks the integration point for T6's device session
switcher and PIN lock. Neither is implemented in T4.

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
| `/account`        | Existing account screen     | `account-sign-out`, `account-sessions`                                                                                           |

`taphoa://join?token=...` remains supported. Invitations opened while signed out
are kept in memory through sign-in and prefill the join form. `/recover` and
`/recovery-code` are removed. Playwright and Maestro suites are owned by later
tasks and were intentionally left unchanged.

## Jest support

`src/test/clerk.ts` provides controllable Clerk auth/session state, `getToken`,
`signIn`/`signUp` resources, SSO, activation and sign-out. `src/test/session.ts`
provides membership fixtures; it contains no credentials. Screen providers resolve
`/me` before mounting shop UI, matching the root gate. The mock API implements
Clerk create/join/me and PIN endpoints and contract tests validate their responses.

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
