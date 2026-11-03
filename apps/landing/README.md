# Tạp Hóa Mini landing page

Deploy this directory as static files; there is no build step or runtime dependency.
`index.html`, `styles.css`, `main.js`, `favicon.svg`, and `img/` are the site.
The API base URL is configured by the `taphoa-api-url` meta tag in `index.html`.

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
