# Design audit captures

These standalone Playwright scripts are not tests and do not match the default `*.spec.ts` suite. Run them from the repository root with Node 24 and the workspace dependencies installed (`pnpm install --frozen-lockfile`). They use the public Clerk development publishable key already documented in `scripts/e2e/stack.sh`; do not use production credentials or a live backend. The Clerk client envelope is fetched from the development Frontend API, then its session is replaced in the browser. The backend is intercepted and served from `src/test/mock`, which has a seeded in-memory database. A synthetic token is used only in the browser. The mock's unimplemented `/v1/sync/changes` returns 404, as in the original audit, and is explicitly checked. Mock product images are substituted with local canvas photos (Hảo Hảo, Oreo, or Coca-Cola), not the actual seeded product images.

Run these commands in separate terminals, from the repository root. Set `TMPDIR=/tmp` if the default temporary path is too long for Chromium's socket. Set `DESIGN_AUDIT_CHROMIUM=/usr/bin/chromium` when using a system browser instead of Playwright's installed Chromium. Output defaults to `/tmp/taphoa-audit-YYYY-MM-DD/` (UTC); set `DESIGN_AUDIT_OUTPUT` to override it.

1. Export the app:

```sh
cd apps/mobile
EXPO_PUBLIC_API_URL=http://localhost:8080 \
EXPO_PUBLIC_ENVIRONMENT=test \
EXPO_PUBLIC_POSTHOG_KEY='' \
EXPO_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com \
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ZnVsbC1tb2NjYXNpbi01NDA3LmNsZXJrLmFjY291bnRzLmRldiQ \
EXPO_PUBLIC_VOICE_FIXTURES=1 \
pnpm exec expo export --platform web --output-dir dist-web
```

2. Serve the app (from `apps/mobile`):

```sh
pnpm exec expo serve dist-web --port 8099
```

3. Serve the board and landing sources (from the repository root):

```sh
node apps/landing/scripts/serve.mjs . 4175
```

4. Capture boards and the landing app (from `apps/mobile`):

```sh
TMPDIR=/tmp PW_TEST_SCREENSHOT_NO_FONTS_READY=1 node e2e-web/design-audit/boards.cjs
```

5. Capture the seeded mobile app (from `apps/mobile`):

```sh
TMPDIR=/tmp PW_TEST_SCREENSHOT_NO_FONTS_READY=1 node e2e-web/design-audit/app.cjs
```

The default list covers inventory, dashboard, account, stock, debts, digest, sales, receipts, expense, close, cart, pay, assistant, voice and enroll. Pass a space- or comma-separated list of routes/states to limit the run, for example:

```sh
TMPDIR=/tmp PW_TEST_SCREENSHOT_NO_FONTS_READY=1 node e2e-web/design-audit/app.cjs inventory stock:low pay:cash pay:credit sign-in
```

`stock:low`, `pay:cash`, and `pay:credit` are supported interactions; `sign-in` uses a real signed-out Clerk session. Other route names capture their default seeded state. Each route emits `seed-<route>.png` at 390×844 and `seed-<route>-tall.png` at 390×1240 with Playwright's `fullPage` option. Tall captures cannot expose content inside an independently scrolling view unless it is scrolled; inspect the screen and add a state before claiming a full comparison. The scripts fail on navigation or capture errors. Do not interpret fixture-dependent empty, error, or substituted-image states as product regressions.

The board script uses each board's registered viewport and skips capture boards and Multi (pending #301). It blocks external fonts as the original audit did. `support.js` is absent, so dynamic bindings, `sc-if`, `sc-for`, and `dc-import` are not evaluated: read the board's inline markup and `text/x-dc` script to understand its intended states. `LandingPhone` is blank for this reason. Board previews are not faithful screenshots of dynamic states. `DESIGN_AUDIT_BOARD_URL` and `DESIGN_AUDIT_APP_URL` override the default local server URLs; the backend interception assumes the export uses `http://localhost:8080`.
