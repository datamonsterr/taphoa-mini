# Tạp Hóa Mini landing page

The site is `index.html`, `styles.css`, `main.js`, `favicon.svg`, and `img/`. It has no
framework and no runtime dependency. The API base URL is configured by the `taphoa-api-url`
meta tag in `index.html`.

## Build and deploy

`scripts/build.mjs` (dependency-free Node) copies the site to `dist/`. It renames every asset
except `index.html` to `<name>.<8-hex sha256>.<ext>` and rewrites the references, so the Caddy
image can cache hashed files for a year. It exits 1 if the page references a missing file.

```sh
pnpm --filter @taphoa/landing build      # writes dist/
pnpm --filter @taphoa/landing test       # node --test: build output checks
docker build -f apps/landing/Dockerfile -t landing .   # from the repository root
docker run --rm -e PORT=8080 -p 8080:8080 landing
bash apps/landing/scripts/check-headers.sh http://127.0.0.1:8080
```

The Dockerfile builds `dist/` on `node:24.22.2-alpine3.24` and copies it into
`caddy:2.11.7-alpine` with `Caddyfile`. Caddy listens on `$PORT` (Railway sets it) and
serves `/healthz` for the health check. `check-headers.sh` asserts the cache, compression and
404 behaviour of the running container. The CI job `landing-e2e` runs the same checks.

Railway deploys the `landing` service from GitHub `main` (production only, declared in
`.railway/railway.ts`). The hosting decision is recorded in
[ADR 0010](../../docs/adr/0010-landing-static-site.md#hosting-2026-11-03).

The Vietnamese copy, layout, tokens, and demo timings come from
`docs/design/canvas/Landing.dc.html` and `LandingPhone.dc.html`. Only the badge
and base typography rules used by the board are copied from the design system.
Google Fonts supplies Be Vietnam Pro, with a system sans-serif fallback.

```sh
pnpm install
pnpm --filter @taphoa/landing serve
pnpm --filter @taphoa/landing exec playwright install chromium
pnpm --filter @taphoa/landing test:e2e
pnpm --filter @taphoa/landing typecheck
pnpm --filter @taphoa/landing lint
pnpm format:check
```

The dependency-free preview server listens on `127.0.0.1:4175`. It also accepts
an optional root directory and port: `node scripts/serve.mjs ../.. 4176`.
Playwright runs the desktop (1440 × 900) and phone (390 × 844) projects without
a backend. Waitlist requests are intercepted; tests never submit real signups.
The visual artifact test writes `screenshots/landing-desktop.png` and
`screenshots/landing-phone.png`. These are gitignored review artifacts, without
snapshot assertions.
