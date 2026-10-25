# Tạp Hóa Mini mobile

TypeScript + Expo Router app (Expo SDK 58) that implements every screen in
[docs/design](../../docs/design/DESIGN.md): camera scan (one / many items), enroll,
cart, VietQR / cash pay, inventory, product, dashboard, expense, end-of-day close and
account. See [the implementation spec](../../docs/specs/mobile-frontend.md) and
[ADR 0003](../../docs/adr/0003-mobile-frontend-stack.md).

## Preview in Expo Go

The app talks only to the real backend (`apps/backend`), at `EXPO_PUBLIC_API_URL`
(default `http://localhost:8080`, the `docker compose up` stack). Start the backend first.
Without a Clerk session the app opens on the sign-in screens (email code or Google); a signed-in
user without a store sees onboarding (create a store or join with an invite code). See
[CLERK.md](CLERK.md). Only libraries bundled in Expo Go are used.

```sh
pnpm install
pnpm --filter @taphoa/mobile start:go
```

Scan the QR code with Expo Go (Android) or the Camera app (iOS) on the same network.
`start` (without `:go`) targets a development build, because `expo-dev-client` is
installed. `pnpm --filter @taphoa/mobile web` runs it in a browser; the camera uses
the webcam there.

The camera captures a real photo and uploads it to `POST /v1/recognition/scans`. Recognition
and enrollment need the model files on the backend; without them the API answers `503` and the
camera shows its scan error. `EMBEDDER=mock` (backend env) lets enrollment work without the
models. Set `EXPO_PUBLIC_API_URL` to the machine the backend runs on: your LAN address for a
physical phone, `http://10.0.2.2:8080` for the Android emulator. Product photos are presigned
URLs from the API; the bucket's public endpoint (`S3_PUBLIC_ENDPOINT_URL`) must be reachable
from the phone too. Tokens are kept in `expo-secure-store` (`localStorage` on the web).

## Deploy the web app (EAS Hosting)

The web build is deployed to [EAS Hosting](https://docs.expo.dev/eas/hosting/get-started/).
The EAS project is already linked in `app.json` (`extra.eas.projectId`), which is
what `eas init --id aacb6d3c-093a-4da0-ae2c-fbc9ce53a458` sets up. One-time setup:

```sh
npm install --global eas-cli
eas login
```

Then, from the repository root:

```sh
pnpm deploy:web
```

This exports the web build to `apps/mobile/dist-web` (`dist` holds the Android
export) and runs `eas deploy --export-dir dist-web`, which prints a preview URL.
`pnpm deploy:web:prod` also promotes it to the production URL. Pushes to `main`
deploy to production through `.eas/workflows/deploy-web.yml` once the GitHub
repository is linked to the EAS project. Set `EXPO_PUBLIC_API_URL` to the deployed backend
at export time; the backend answers CORS for any origin.

Use Node 24 (`nvm use` from the repository root) and pnpm 11.5.0. All commands below
run from the repository root unless noted.

```sh
pnpm install
cp apps/mobile/.env.example apps/mobile/.env
pnpm --filter @taphoa/mobile start
pnpm --filter @taphoa/mobile android
pnpm --filter @taphoa/mobile ios
pnpm --filter @taphoa/mobile web
```

Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to the backend address reachable
from your device: `http://10.0.2.2:8080` for the Android emulator or your computer's
LAN IP for a physical phone. `localhost` refers to the phone itself. Expo embeds
`EXPO_PUBLIC_*` values in the bundle, so these must never contain secrets. Restart
or reload the app after changing them. Typed API calls and React Query hooks live in `src/lib/api`.

```sh
pnpm --filter @taphoa/mobile lint
pnpm --filter @taphoa/mobile typecheck
pnpm --filter @taphoa/mobile test
pnpm --filter @taphoa/mobile test:coverage # enforces 90 % statements/lines/functions, 85 % branches
pnpm --filter @taphoa/mobile build # Android JS/assets export to apps/mobile/dist
pnpm --filter @taphoa/mobile build:all # Android, web and iOS exports
pnpm format
pnpm format:check
```

Root `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, and `build` scripts
run workspace tasks through Turborepo. Missing package scripts are skipped; mobile
has no separate integration suite. Jest uses `jest-expo` and React Native Testing
Library. Tests form a pyramid: unit tests next to logic, component tests in
`src/components`, screen tests in `src/features` against an in-memory fake of the API
(`src/test/mock`, a Jest double that no runtime file may import; `__tests__/no-test-double-in-runtime.test.ts`
enforces it), a contract test (`__tests__/contract`) that validates every fake response
against the OpenAPI schemas, and flow tests (`__tests__/flows`) that drive the real routes with
`expo-router/testing-library`.

## Android smoke test and EAS

With a built APK installed on a running emulator/device and the Maestro CLI on
PATH:

```sh
pnpm --filter @taphoa/mobile test:e2e
```

The Maestro flows in `.maestro/` (smoke, onboarding, inventory, checkout) launch
`com.datamonsterr.taphoamini` against the real backend (`scripts/e2e/stack.sh up`; the
emulator reaches it as `http://10.0.2.2:8080`). Each flow creates a store of its own
(`subflows/create-store.yaml`), so none depends on another's data or on what recognition makes
of the emulator's virtual camera: products are added by hand (`subflows/enroll-product.yaml`).
Shared cold start (fresh state, camera permission, wait for the welcome screen) lives
in `.maestro/subflows/launch.yaml`; flows call it with `runFlow` and take a
`takeScreenshot` at each screen. `maestro check-syntax <file>` validates a flow
without a device.

### GitHub Actions (free, no Expo plan)

`.github/workflows/android-e2e.yml` runs on pull requests that touch the app, backend or
shared packages, and on manual dispatch:
`expo prebuild --platform android`, `./gradlew assembleRelease` (x86_64 only), then
all flows on an API 34 `google_apis` x86_64 emulator
(`reactivecircus/android-emulator-runner`, KVM enabled, virtual-scene camera so the
shutter returns a real image) via `scripts/e2e-android.sh`. The release variant is
used because it embeds the Hermes bundle, so no Metro server is needed; the Expo
template signs it with the debug keystore. Artifacts: `maestro-report` (JUnit XML)
and `maestro-debug` (screenshots, commands, logs). The Maestro CLI is pinned
through `MAESTRO_VERSION` in the workflow.

**Jank budget.** `e2e-android.sh` resets `dumpsys gfxinfo` before the suite, saves the raw
output as the `gfxinfo` artifact, and `scripts/gfxinfo-budget.mjs` prints a table to the
job summary on every run. The job fails only on a catastrophic regression: janky frames
above 98 % or a 90th percentile frame time above 500 ms. The CI emulator renders with
swiftshader (software GPU) and is far slower than any phone (first real run: 90.59 % janky,
p90 250 ms), so its numbers are trend-only and no phone-grade budget applies there.
Smoothness on real hardware is gated by the web perf spec (60 fps, 0 % of frames above
34 ms, CPU throttled 4×) and the render-count tests. Override the limits with
`JANK_MAX_PERCENT` / `JANK_MAX_P90_MS`. Parser tests: `node --test scripts/`.

**Expo Go preview.** The second job, `expo-go`, starts Metro on the runner
(`expo start --go --port 8081 --host lan`, with `REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2`),
pre-warms the Android bundle, then `scripts/e2e-expo-go.sh` installs the official Expo Go
APK for the project's SDK (the URL comes from the same `api.expo.dev/v2/versions/latest`
lookup the Expo CLI uses), opens `exp://10.0.2.2:8081`, and runs
`.maestro/expo-go/preview.yaml`: the app's welcome screen (no backend runs in that job). Artifacts:
`expo-go-debug` (screenshots, JUnit XML) and `expo-go-metro-log`.

### EAS

`eas.json` defines development (dev client/internal), preview (internal APK),
production, and unsigned Android E2E profiles. `.eas/workflows/build-preview.yml`
builds a preview on push to `main` only when the Android fingerprint changed; otherwise
it reuses the matching earlier build. There is no EAS Maestro workflow: EAS Maestro jobs
need a paid Expo plan, so the flows run in GitHub Actions instead. No remote build is needed for local lint/tests/export.
The Android export is a Metro JS/assets build, not an installable APK.

## Docker development server

Build using the repository root as context:

```sh
docker build -f apps/mobile/Dockerfile.dev -t taphoa-mobile-dev .
docker run --rm -it -p 8081:8081 \
  -e REACT_NATIVE_PACKAGER_HOSTNAME=192.168.1.10 \
  -e EXPO_PUBLIC_API_URL=http://192.168.1.10:8080 \
  taphoa-mobile-dev
```

Replace `192.168.1.10` with your host's LAN IP. The container runs Expo in LAN mode
on port 8081; the phone and host must share a network, with that port reachable.
The image includes workspace dependencies and the source at build time; rebuild
after editing, or mount source directories for live development. No tunnel or
Expo login is needed for LAN mode.

## Expo MCP

`expo-mcp` is installed for local capabilities. In an environment already
authenticated with Expo, start with:

```sh
EXPO_UNSTABLE_MCP_SERVER=1 pnpm --filter @taphoa/mobile start
```

See the current official docs for [Expo monorepos](https://docs.expo.dev/guides/monorepos/),
[Jest](https://docs.expo.dev/develop/unit-testing/),
[EAS Workflows](https://docs.expo.dev/eas/workflows/), and
[Expo MCP](https://docs.expo.dev/mcp/).

## Performance budgets

CI enforces three kinds of budget. Numbers are medians of local runs (Chromium, software rendering, fake webcam, the real backend with the SAM and DINO models on the same 12-core machine, every API call a real HTTP request).

**Web interactions** (`e2e-web/perf.spec.ts`, budgets in `e2e-web/perf-budgets.ts`, results in `e2e-web/perf-results.json` and the Playwright report). Each input event is timed to the first frame that shows the result; route chunks are warmed first.

| Interaction                           | Median  | Budget  |
| ------------------------------------- | ------- | ------- |
| shutter → first detection box, single | 1520 ms | 3500 ms |
| shutter → first detection box, multi  | 1596 ms | 3500 ms |
| `+` → cart pill updated               | 12 ms   | 300 ms  |
| cart pill → first cart row            | 328 ms  | 500 ms  |
| QR button → VietQR svg                | 329 ms  | 1000 ms |
| tab Kho → Báo cáo                     | 178 ms  | 1000 ms |
| tab Báo cáo → Tài khoản               | 180 ms  | 1000 ms |
| tab Tài khoản → Kho                   | 29 ms   | 300 ms  |
| search keystroke → filtered grid      | 274 ms  | 700 ms  |
| search clear → full grid              | 261 ms  | 700 ms  |

A scan is the real recognition pipeline: upload, SAM segmentation (about 1.3 s here), DINO embedding, vector search. A CI runner's CPU needs about 2 s, so its budget is 3500 ms: room for a slower runner, not for a model twice as slow. The scan budgets used to be 700 ms against the in-app mock. Search is the 250 ms debounce plus one local round trip. The cart sheet is bound by its 280 ms slide.

**Animations** (cart sheet open, mode toggle): 60 fps average, longest frame gap 16.8 ms, 0% frames over 34 ms. Budget: average ≥ 50 fps, ≤ 5% frames over 34 ms. No long task (> 50 ms) occurred; budget: none over 200 ms.

**Throttled** (CDP CPU rate 4, a mid-range phone approximation, separate looser budgets): latencies stay within about 10% of unthrottled (the scan is backend time), animations 60 fps, longest task 93 ms. Budget: latency ≤ 2× the above, ≥ 30 fps, ≤ 20% frames over 34 ms, no task over 500 ms.

**Bundle size** (`pnpm --filter @taphoa/mobile check:bundle` after `build:all`, budgets in `scripts/bundle-budget.mjs`): android Hermes bundle 7.17 MiB (budget 8.25 MiB), web JS 887 KiB gzip (budget 1020 KiB). Each budget is the measured size plus about 15%.

**Render counts** (jest): toggling one detection box, a cart change on the camera screen, typing in the inventory search and incrementing one cart line each re-render only what changed.

Run the perf suite alone with `pnpm exec playwright test --project=perf`; it runs last in `test:e2e:web` so no other spec shares the CPU.

## Web E2E against the real backend

`test:e2e:web` (Playwright, `e2e-web/`) exports the web app with `EXPO_PUBLIC_API_URL` (default
`http://localhost:8080`) and drives it against the real backend with the SAM and DINO models,
not the in-app mock. `e2e-web/global-setup.ts` fails the run at once when `/readyz` is not 200.

```sh
scripts/e2e/stack.sh up      # postgres + redis + storage (compose project taphoa-e2e), backend with models
pnpm --filter @taphoa/mobile test:e2e:web
scripts/e2e/stack.sh down    # stops the backend, removes containers and volumes
```

`stack.sh up` builds `apps/backend` in release mode (or uses the binary in `BACKEND_BIN`),
downloads ONNX Runtime and the model weights once into `apps/backend/onnxruntime` and
`apps/backend/models`, and writes the pid and log to the gitignored `.e2e-stack/`. Other
stacks can run beside it: override `E2E_BACKEND_PORT` (8080), `E2E_POSTGRES_PORT` (55532),
`E2E_REDIS_PORT` (56579) and `E2E_STORAGE_PORT` (9100); set `EXPO_PUBLIC_API_URL` to match a
non-default backend port. `E2E_SKIP_MODELS=1` skips the models (recognition then returns 503).

Every test drives the real UI against that backend: a tap makes a real HTTP request, the backend
answers, the screen shows the answer. Nothing intercepts or fakes an API call
(`page.route` on the API is not used); the specs only observe calls (`callApi` / `waitForApi` in
`e2e-web/fixtures.ts`) and compare the screen with the response. Each test gets its own store: the
`store` fixture creates it with `POST /v1/stores` and starts the browser signed in (the session is
written to `localStorage` in the shape `src/stores/session.ts` stores it), so tests are parallel safe.
`onboarding.spec.ts` creates its stores through the UI instead.

The fake camera plays one product photo. Generate the clip and the still once:

```sh
apps/mobile/e2e-web/fixtures/make-video.sh   # ffmpeg: one red pack from shelf-1600.jpg -> fixtures/product.mjpeg + product.jpg
EXPO_PUBLIC_API_URL=http://localhost:8080 pnpm --filter @taphoa/mobile test:e2e:web
```

`playwright.config.ts` plays `fixtures/product.mjpeg` when it exists (or the clip named by
`PLAYWRIGHT_FAKE_VIDEO`) and serves the export on `E2E_WEB_PORT` (8099). Seeded products are
enrolled with `product.jpg`, so a scan of the camera matches them; an empty store sees the same
picture as unknown, and enrolling it makes the next shot a match.

The backend has one inference slot: a scan that finds it taken answers 503 "segmenter busy". The
parallel workers therefore take turns for anything that runs the models (scans, enrolling), through
a lock directory under `e2e-web/test-results/`.

What the suite cannot cover yet: the backend reports no `stock_quantity`, so stock badges and the
low-stock alert never show; the price history has an endpoint but no screen (the edit-price spec
reads it from the API); there is no UI path that sells a loose item at a typed price (the
dashboard review list is exercised with a line sold through the API).

In CI the `web-e2e` job runs the same steps using the `backend-binary` artifact. The Android
Maestro workflow starts the stack too and builds the APK for `http://10.0.2.2:8080`.
