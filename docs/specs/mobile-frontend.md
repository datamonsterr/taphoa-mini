# Mobile frontend (Expo app) — implementation spec

Status: Accepted · Date: 2026-10-23 · Design: [docs/design/DESIGN.md](../design/DESIGN.md) · API: [docs/api/openapi.yaml](../api/openapi.yaml) · ADR: [0003](../adr/0003-mobile-frontend-stack.md)

## 1. Goal

Build every screen in `docs/design` (boards 01–13) as a working Expo app in `apps/mobile`.
All data goes through a typed client for `docs/api/openapi.yaml` to the **real backend** at
`EXPO_PUBLIC_API_URL`. The app has no mock mode. Jest uses a schema-valid in-memory fake that lives
under `src/test/mock`; E2E runs use the real backend (`scripts/e2e/stack.sh`).

## 2. Acceptance criteria

1. **Camera.** Screen 01 shows a live `expo-camera` preview. The shutter captures a real photo. The
   frozen photo fills the viewfinder and `POST /v1/recognition/scans` returns detections. Each detection's
   bounding box (`[x, y, width, height]` in image pixels) is drawn over the photo, scaled correctly
   to the viewfinder. Single mode gives one box (match or low match). Multi mode gives 2–4 boxes.
2. **API.** Every call uses an operation and schema from `docs/api/openapi.yaml`. A contract test
   validates every response of the jest fake against the OpenAPI response schema for that
   operation and status, so the fake cannot drift from the spec.
3. **Design match.** Layout, sizes, colours, type, radius and states come from the boards in
   `docs/design/canvas/*.dc.html`, `tokens.css` and `DESIGN.md` §2–§6. Each icon-only control has the
   Vietnamese `accessibilityLabel` that the board uses as `aria-label`.
4. **Every control works** against the real backend along the flow in `DESIGN.md` §5:
   onboarding (create a store, join, recover) →
   camera → box/price → `+` → cart pill → cart → QR → pay → received (sale created, cart cleared);
   low match → enroll → product created and line added to cart;
   swipe up → shop (Kho / Báo cáo / Tài khoản) → product detail / expense sheet / Chốt sổ sheet.
5. **Expo Go preview.** `pnpm --filter @taphoa/mobile start:go` starts Metro for Expo Go. Use only
   libraries that ship in Expo Go for SDK 58. No custom native code.
6. **Tests.** Test pyramid (§6). `pnpm --filter @taphoa/mobile test` passes with coverage thresholds
   enforced (global statements/lines/functions ≥ 90 %, branches ≥ 85 %, on `src/**`).
   `lint` and `typecheck` pass. CI runs all of these.
7. **Performance.** Animations run on the UI thread (Reanimated). Stores use selectors. List screens
   virtualize. No layout jank on sheet open, box select, strip open.

## 3. Out of scope

`DESIGN.md` §8 items (grid-mode add, barcode, TTS, void, CSV export). Offline sync, `/v1/events`.
Native modules outside Expo Go. Backend changes. Changing `docs/api/openapi.yaml`.

## 4. Stack

Expo SDK 58, Expo Router (routes in `src/app`), TypeScript strict. Install every package with
`npx expo install <pkg>` (pnpm workspace; run inside `apps/mobile`). Read the SDK 58 docs before
using an API: `https://docs.expo.dev/versions/v58.0.0/` and `https://docs.expo.dev/llms.txt`.

| Need          | Library                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| Camera        | `expo-camera` (`CameraView`, `useCameraPermissions`, `takePictureAsync`)      |
| Animation     | `react-native-reanimated` (+ `react-native-worklets` if SDK 58 requires it)   |
| Gestures      | `react-native-gesture-handler`                                                |
| Icons         | `lucide-react-native` + `react-native-svg` (Lucide line icons, as the boards) |
| Images        | `expo-image`                                                                  |
| Font          | `@expo-google-fonts/be-vietnam-pro` + `expo-font`                             |
| Server state  | `@tanstack/react-query`                                                       |
| Client state  | `zustand` (cart, settings, scan session)                                      |
| Lists         | `@shopify/flash-list` or `FlatList` with fixed item layout                    |
| Haptics       | `expo-haptics` (add, received)                                                |
| Contract test | `ajv`, `ajv-formats`, `yaml` (dev only)                                       |

## 5. Layout of `apps/mobile/src`

```
app/                         routes only; each file thin, renders a screen from features/
  _layout.tsx                providers: GestureHandlerRootView, SafeAreaProvider, QueryClientProvider, fonts, Stack
  index.tsx                  01–04 camera (one screen, state decides match / multi / unknown)
  enroll.tsx                 05 sheet (presentation: formSheet or transparentModal + own sheet)
  cart.tsx                   06 sheet
  pay.tsx                    07
  (shop)/_layout.tsx         bottom bar: camera FAB + nav pill Kho / Báo cáo / Tài khoản
  (shop)/inventory.tsx       08
  (shop)/dashboard.tsx       10
  (shop)/account.tsx         12
  product/[id].tsx           09
  expense.tsx                11 sheet
  close.tsx                  13 sheet
theme/                       tokens.ts (from tokens.css), typography, spacing; no hard-coded colours elsewhere
components/ui/               light-surface components (DESIGN.md §6 light table)
components/camera/           camera-surface components (DESIGN.md §6 camera table)
features/<feature>/          screen component, hooks, pure logic, strings.ts
  camera/ enroll/ checkout/ pay/ inventory/ product/ dashboard/ expense/ close/ account/
lib/api/                     client factory, typed calls per operation, React Query hooks + keys
(onboarding)/                welcome, create, join, recover, recovery-code (no session yet)
stores/session.ts            token pair, member, store; Keychain / Keystore, localStorage on the web
lib/format.ts                VND money (`12.000đ`), dates
lib/i18n.ts                  `t()` + VI/EN; each feature owns its strings in features/<x>/strings.ts
stores/                      zustand stores
test/                        render helpers (providers, router), jest setup, mocks for native modules
test/mock/                   jest-only fake of the API: fetch, in-memory DB, scenario control
```

Path alias `@/*` → `src/*`.

## 6. Tests (pyramid)

| Layer      | Where                           | What                                                                        |
| ---------- | ------------------------------- | --------------------------------------------------------------------------- |
| Unit       | `src/**/X.test.ts` next to code | stores, money, bbox scaling, keypad reducer, fake DB, i18n                  |
| Component  | `src/components/**/X.test.tsx`  | every component and every state in DESIGN.md §6; a11y labels; press         |
| Screen     | `src/features/**/X.test.tsx`    | screen with the fake API: loading, data, error, every button                |
| Contract   | `__tests__/contract/*.test.ts`  | each fake response validates against OpenAPI schema                         |
| Flow       | `__tests__/flows/*.test.tsx`    | `expo-router/testing-library` `renderRouter`: §2.4 flows end to end         |
| E2E web    | `e2e-web/*.spec.ts`             | Playwright on the web export, real backend and models, no API mocks         |
| E2E device | `.maestro/*.yaml`               | smoke, onboarding, inventory, checkout on an Android emulator, real backend |

TDD: write the failing test first, then code. Use `@testing-library/react-native` queries by role
and label. Mock native modules (`expo-camera`, `expo-haptics`, Reanimated) in `src/test/setup.ts`.
Coverage thresholds live in the jest config so CI fails below them.

## 7. API access and test doubles

- `getApiClient()` returns a client for `EXPO_PUBLIC_API_URL` (default `http://localhost:8080`;
  the Android emulator reaches the host as `http://10.0.2.2:8080`). There is no `EXPO_PUBLIC_API_MODE`
  and no mock mode. The client wraps `fetch` with `createAuthFetch`: bearer token from the session
  store, one refresh-token rotation on a 401, the session cleared when the server refuses it.
- The root layout shows the onboarding screens until a session exists and its recovery code (if
  any) has been acknowledged; signing out returns there and clears the cache and the cart.
- Jest injects the fake of `src/test/mock` through `setApiTransport`. It routes by method + path,
  reads multipart / JSON bodies, mutates an in-memory DB and returns JSON typed with
  `components['schemas'][...]`. `createScan` returns dummy boxes in image pixels (scenario control:
  `setMockScenario('match' | 'multi' | 'unknown')`). It adds an optional `stock_quantity` to
  products for the stock badges: the **real API does not return it yet**, so against the backend
  stock badges and the low-stock alert stay hidden.
- The report summary lists only the buckets that have activity; the app fills the missing days,
  weeks and months with zeros (`src/lib/api/summary.ts`) so the chart has its 7 / 6 / 6 columns and
  the newest column is always today, this week or this month.
- "Sold without catalog" uses `GET /v1/review/manual-lines`. Enrolling from a line sends
  `from_manual_line_id` with `POST /v1/products`, which resolves the line as `enrolled`.
- The E2E suites never fake an API call: see `apps/mobile/README.md` "Web E2E against the real backend".

## 8. Tasks and dependencies

```
F1 foundation ──┬─► C1 camera components ──┐
                ├─► C2 light components ───┼─► V1 camera 01–04 ─┐
F2 mock API ────┴──────────────────────────┤   V2 enroll/cart/pay ├─► Q validation + fixes ─► CI
                                           │   V3 inventory/product
                                           │   V4 dashboard/expense/close
                                           └─► V5 account ───────┘
```

F2 depends on F1. C1, C2 depend on F1. V* depend on F2, C1, C2. Q depends on all V*.
A view task touches only its own `features/<x>/`, its route file(s), its tests and its Maestro flow.
