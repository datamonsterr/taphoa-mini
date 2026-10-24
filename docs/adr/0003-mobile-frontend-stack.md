# 0003 — Mobile frontend stack and the real backend

Status: Accepted · Date: 2026-10-23 · Amended: the app no longer ships an in-app mock API

## Context

The design (docs/design) covers 13 screens. The app was first built against an in-app mock `fetch`
so it could be previewed in Expo Go before the backend implemented auth, catalog, recognition,
sales and reports. The backend now implements all of that, and a mock inside the shipped app only
hides integration bugs (a scan that never fails, summary buckets that are always complete).

## Decision

- Expo SDK 58 + Expo Router, only Expo Go–compatible libraries: expo-camera, Reanimated, Gesture
  Handler, lucide-react-native over react-native-svg, expo-image, TanStack Query, zustand.
- All data goes through `@taphoa/api-client` (openapi-fetch over `docs/api/openapi.yaml`) to the
  real backend at `EXPO_PUBLIC_API_URL`. There is no mock mode and no `EXPO_PUBLIC_API_MODE`.
  Requests carry the session's bearer token and rotate it once on a 401 (`src/lib/api/authFetch.ts`).
- The session (token pair, member, store) comes from the onboarding screens (create a store, join
  with an invite, recover with the recovery code) and is kept in Keychain / Keystore, or
  `localStorage` on the web.
- Jest uses a schema-valid in-memory fake (`src/test/mock`) injected through `setApiTransport`. It
  lives under `src/test` and is never part of the app bundle. A contract test validates every fake
  response against the OpenAPI schemas, so the fake cannot drift from the spec.
- End-to-end tests run against the real backend with the real recognition models: Playwright on
  the web export (`apps/mobile/e2e-web`) and Maestro on an Android emulator
  (`apps/mobile/.maestro`), both started by `scripts/e2e/stack.sh`. They do not intercept API calls.

## Consequences

- A screen that breaks against the real API fails in CI (the web E2E job), not in production.
- The fake must be kept in step with the spec; the contract test enforces it in CI.
- The backend must be reachable to run or preview the app; `scripts/e2e/stack.sh up` starts one
  with models, and `docker-compose.yml` starts the services alone.
- Prism (`pnpm mock:api`) remains available for testing the client path against the spec.
