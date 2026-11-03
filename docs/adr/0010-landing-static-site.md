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

- **`apps/landing` is a static site with no build step.** `index.html`, one stylesheet, one
  script and the product images. Tokens are copied from `docs/design/canvas/ds/taphoa/tokens.css`.
  Any static host can serve the folder as is.
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
- Hosting is not chosen here. The folder deploys to any static host; wiring a deploy is a
  follow-up.
- Copy and design changes are edits to plain HTML and CSS, reviewed against the boards.
