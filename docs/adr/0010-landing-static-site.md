# ADR 0010: The marketing landing page is a static site in `apps/landing`, with a waitlist endpoint in the backend

Status: Accepted · Date: 2026-11-03 · Design: `docs/design/canvas/Landing.dc.html`, `docs/design/canvas/LandingPhone.dc.html`

## Context

The design boards describe a one-page marketing site: a hero with an animated phone scan demo,
an enrollment demo, a voice demo, an analytics bento and a waitlist form. The page needs no
sign-in, no data from a store and no routing. Its only server call is the waitlist signup.

The monorepo has no web app other than the Expo web export of `apps/mobile`. That export is the
shop app itself (Clerk sign-in, React Native Web, a large bundle) and its `web-e2e` suite needs
the backend binary, the models and Clerk secrets.

Options weighed:

| Option                                   | Cost                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| A route in the Expo app                  | ships the app bundle to every visitor; React Native Web cannot express the CSS motion |
| A framework site (Next.js, Astro, Vite)  | a new build toolchain and dependency tree for one page                                |
| Plain HTML, CSS and JavaScript, no build | none beyond a test runner; the boards are already HTML and CSS                        |

The waitlist needs somewhere to keep emails. A third-party form service would add an account,
a secret and a data processor; the backend already has Postgres, rate limiting and an error
envelope.

## Decision

- **`apps/landing` is a static site with no framework.** `index.html`, one stylesheet, one
  script and the product images. Tokens are copied from `docs/design/canvas/ds/taphoa/tokens.css`.
  `scripts/build.mjs` copies the site to `dist/` and gives every asset except `index.html` a
  content hash in its name (see Hosting below).
- **Tests use Playwright** (the version `apps/mobile` pins) against a local static server, at
  1440 and 390 widths. The waitlist request is intercepted in the browser tests, so the suite
  needs no backend and runs in a plain CI job.
- **`POST /v1/waitlist`** in the backend, unauthenticated and rate limited per client. It
  validates the email on the server, stores it in `waitlist_signups`, and answers the same way
  for a new and a repeated email, so the form cannot be used to learn who signed up.
- The page reads the API base URL from a `<meta name="taphoa-api-url">` tag, defaulting to the
  production backend.

## Consequences

- No bundler, framework or package beyond Playwright enters the repo for the landing page.
- Hosting is chosen in [Hosting (2026-11-03)](#hosting-2026-11-03) below.
- Copy and design changes are edits to plain HTML and CSS, reviewed against the boards.

## Hosting (2026-11-03)

The page needs a public URL, cache headers that fit its asset names, compression, and a custom
domain later. The backend stays the only API. Prices and behaviour were checked against Railway
docs on 2026-11-03.

| Option                                                                 | Idle cost and cold start                                             | Headers and compression                                                                                                                    | Verdict                                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Railpack static detection (`index.html` at the root, Caddy underneath) | One small service, about $0.20/month of RAM at idle; sleep off       | Built-in Caddyfile sets no `Cache-Control` and a CSP of `default-src 'self'`, which blocks Google Fonts and the cross-origin waitlist call | Rejected: the headers cannot be changed without a custom server                              |
| Own Caddy image on the official `caddy` alpine tag (chosen)            | Same service shape, about 15–25 MB RAM, about $0.20/month; sleep off | `Cache-Control` per class, security headers, `encode zstd gzip`, no `Server` header, set in `apps/landing/Caddyfile`                       | **Chosen**                                                                                   |
| Rust backend serves `apps/landing/dist`                                | Adds files to the backend image and a process to the backend service | Same headers would need Rust code                                                                                                          | Rejected: marketing deploys wait for the roughly 9-minute Rust build and share its rollbacks |
| nginx image                                                            | Same as Caddy                                                        | Equivalent headers in hand-written config; automatic TLS unused here                                                                       | Rejected: no gain over Caddy for one static page                                             |

Railway prices RAM at $10 per GB per month and CPU at $20 per vCPU per month
(docs.railway.com/pricing/plans). A Caddy process at 20 MB idles near $0.20 per month.

Decisions:

- **Railway service `landing`**, declared in `.railway/railway.ts` in the production block only.
  It builds `apps/landing/Dockerfile` from the repository root on pushes to `main` that touch
  `apps/landing/**`. Replicas run in `sin` with the backend. Health check `/healthz`; restart
  retries capped at 5, like the backend.
- **App Sleeping stays off.** Railway wakes a slept app on traffic, but the first request can
  return 502 (docs.railway.com/reference/app-sleeping). An idle Caddy costs less than the
  retry risk on a landing page.
- **Railway CDN is on** (`cdn: { enabled: true }`, docs.railway.com/networking/cdn). It is free
  and off by default. Its HTML caching is `auto`, so it caches only HTML that sends `max-age` or
  `s-maxage`; `/` sends `no-cache`, so the edge caches hashed assets and not the page. The edge
  purges HTML on deploy by default and compresses (Brotli preferred, gzip fallback).
- **Cache classes.** `scripts/build.mjs` writes `<name>.<8-hex sha256>.<ext>` for every asset
  except `index.html`. The Caddyfile sends `public, max-age=31536000, immutable` for hashed
  names, `no-cache` for `/` and `*.html` (ETag and Last-Modified revalidate), and
  `public, max-age=3600` for anything else. Unknown paths return 404; there is no SPA fallback.
- **Domain.** The service uses the generated `*.up.railway.app` domain for now. A custom domain
  needs a CNAME and a TXT record at the owner's DNS provider; Railway issues Let's Encrypt
  certificates automatically and allows two custom domains per Hobby service
  (docs.railway.com/networking/domains/working-with-domains). The owner adds it.
- **Waitlist stays cross-origin.** The page calls `https://backend-production-5f5c.up.railway.app`
  directly. The backend already answers CORS with `CorsLayer::permissive`, so no backend change
  is needed. A Caddy reverse proxy for `/v1/*` would add a hop, so the backend would see the proxy
  address instead of the client, and the per-client rate limit (`CLIENT_IP_SOURCE=x-real-ip`)
  would stop working.

Consequences:

- Marketing deploys build in seconds to minutes, not the backend's Rust build time, and roll
  back on their own.
- The page sends no Content-Security-Policy yet. **Follow-up:** add a CSP that allows
  `fonts.googleapis.com`, `fonts.gstatic.com` and the backend origin, and test it in the Playwright
  suite before it ships.
- Image and style changes take effect on the next deploy because the file names change. Old
  hashed names stay cached at the edge until purged or expired.
- The CI job `landing-e2e` runs the Playwright suite on the source tree, the Node unit test on
  `dist/`, and `scripts/check-headers.sh` against the built Caddy image.
