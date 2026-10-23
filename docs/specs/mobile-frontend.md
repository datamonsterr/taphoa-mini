# Mobile frontend (Expo app) — implementation spec

Status: Accepted · Date: 2026-10-23 · Design: [docs/design/DESIGN.md](../design/DESIGN.md) · API: [docs/api/openapi.yaml](../api/openapi.yaml) · ADR: [0003](../adr/0003-mobile-frontend-stack.md)

## 1. Goal

Build every screen in `docs/design` (boards 01–13) as a working Expo app in `apps/mobile`.
All data goes through a typed client for `docs/api/openapi.yaml`. By default the client talks to an
**in-app mock API** whose responses conform to the OpenAPI schemas, so the app runs with no backend.

## 2. Acceptance criteria

1. **Camera.** Screen 01 shows a live `expo-camera` preview. The shutter captures a real photo. The
   frozen photo fills the viewfinder and the mock `createScan` returns detections. Each detection's
   bounding box (`[x, y, width, height]` in image pixels) is drawn over the photo, scaled correctly
   to the viewfinder. Single mode gives one box (match or low match). Multi mode gives 2–4 boxes.
2. **API.** Every call uses an operation and schema from `docs/api/openapi.yaml`. A contract test
   validates every mock response against the OpenAPI response schema for that operation and status.
3. **Design match.** Layout, sizes, colours, type, radius and states come from the boards in
   `docs/design/canvas/*.dc.html`, `tokens.css` and `DESIGN.md` §2–§6. Each icon-only control has the
   Vietnamese `accessibilityLabel` that the board uses as `aria-label`.
4. **Every control works** with the mock API along the flow in `DESIGN.md` §5:
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

`DESIGN.md` §8 items (duplicate prompt, grid-mode add, barcode, TTS, void, onboarding, CSV export).
Real auth flow: the mock client starts signed in as the Lead of a demo store. Offline sync, `/v1/events`.
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
lib/mock/                    mock fetch, in-memory DB seeded from fixtures, scenario control
lib/format.ts                VND money (`12.000đ`), dates
lib/i18n.ts                  `t()` + VI/EN; each feature owns its strings in features/<x>/strings.ts
stores/                      zustand stores
test/                        render helpers (providers, router), jest setup, mocks for native modules
```

Path alias `@/*` → `src/*`.

## 6. Tests (pyramid)

| Layer      | Where                           | What                                                                 |
| ---------- | ------------------------------- | -------------------------------------------------------------------- |
| Unit       | `src/**/X.test.ts` next to code | stores, money, bbox scaling, keypad reducer, mock DB, i18n           |
| Component  | `src/components/**/X.test.tsx`  | every component and every state in DESIGN.md §6; a11y labels; press  |
| Screen     | `src/features/**/X.test.tsx`    | screen with mock API: loading, data, error, every button             |
| Contract   | `__tests__/contract/*.test.ts`  | each mock response validates against OpenAPI schema                  |
| Flow       | `__tests__/flows/*.test.tsx`    | `expo-router/testing-library` `renderRouter`: §2.4 flows end to end  |
| E2E device | `.maestro/*.yaml`               | same flows on a device (run by EAS workflow `e2e.yml`, not in PR CI) |

TDD: write the failing test first, then code. Use `@testing-library/react-native` queries by role
and label. Mock native modules (`expo-camera`, `expo-haptics`, Reanimated) in `src/test/setup.ts`.
Coverage thresholds live in the jest config so CI fails below them.

## 7. Mock API rules

- `getApiClient()` returns a client for `EXPO_PUBLIC_API_URL` when `EXPO_PUBLIC_API_MODE=live`;
  otherwise it injects `createMockFetch()` into `createApiClient({ fetch })`.
- The mock routes by method + path, reads multipart / JSON bodies, mutates an in-memory DB and
  returns JSON typed with `components['schemas'][...]`. Simulated latency 120–350 ms (0 in tests).
- `createScan` reads the uploaded image size when given (else 1080×1440) and returns **dummy boxes
  in image pixels**: single mode one central box; multi mode 3 boxes. Scenario control
  (`setMockScenario('match' | 'multi' | 'unknown')`, default: follow `mode`, and every 3rd single scan
  is `unknown`) makes the low-match state reachable in the app and deterministic in tests.
- Seed: a demo store, 12 products with Vietnamese names, prices, stock, cost, 1–2 images each
  (bundled placeholder images), sales and expenses for 7 days, alerts, a bank account.
- Proposed API extension: Product.stock_quantity (pending spec). The mock adds an optional integer
  `stock_quantity` (base units) to every Product response for the stock badges (Inventory, Product
  detail, Dashboard low-stock alert; low means `<= LOW_STOCK_THRESHOLD`, 5). Sales decrement it and
  purchase lines on expenses increase it. It is the only property beyond `docs/api/openapi.yaml`;
  the contract test fails if the mock serves any other. The real API does not return it yet.
- "Sold without catalog" uses `GET /v1/review/manual-lines` and `POST .../{lineId}/resolve`. The mock
  seeds 3 open lines and `createSale` lines with `source: manual` add more.

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
