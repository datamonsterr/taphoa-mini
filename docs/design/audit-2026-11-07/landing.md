# Landing design comparison — 2026-11-07

Compared `Landing.dc.html` and `LandingPhone.dc.html` with the built `apps/landing` after merging fetched `origin/main` into the audit branch. The site was built with `pnpm build` and served on 8115; the repository board was served on 4215. Captures were viewed in full and compared section by section at 1440×900 and 390×844, with full-page screenshots. External requests, including Google Fonts, were blocked for both captures, so typography was compared in the shared fallback font; the declared Be Vietnam Pro face was checked in source, not visually verified as loaded.

The board capture script was run with `DESIGN_AUDIT_BOARD_URL=http://127.0.0.1:4215` and `DESIGN_AUDIT_OUTPUT=/tmp/taphoa-audit-landing`. A separate Playwright capture used the requested actual viewport heights and `fullPage: true` against the built site on 8115. Images exceed 200 KB except the blank phone board, so none are committed: `/tmp/taphoa-audit-landing/board-desktop.png`, `/tmp/taphoa-audit-landing/site-desktop.png`, `/tmp/taphoa-audit-landing/board-phone.png`, `/tmp/taphoa-audit-landing/site-phone.png`.

`support.js` is absent: the desktop board shows unevaluated bindings and simultaneously visible conditional content, and the phone board is blank. Phone expectations come from the import in `docs/design/canvas/LandingPhone.dc.html:17`, the responsive CSS in `docs/design/canvas/Landing.dc.html:257`, and its state script at `docs/design/canvas/Landing.dc.html:542`. Thus matches below concern the visible/static and source-defined aspects inspected, not proof of pixel parity for every animated state.

| Section                       | Classification | Evidence                                                                                                                                                                                                                                                                                   |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Navigation and hero           | match          | Brand, three desktop anchors, early-signup link, Vietnamese headline, description, trust lines, camera illustration and product imagery correspond (`docs/design/canvas/Landing.dc.html:304`, `apps/landing/index.html:28`). Phone hides navigation links and floating chips as specified. |
| Specifications                | match          | Four measures and their order match; the two-column phone layout follows the board (`docs/design/canvas/Landing.dc.html:387`, `apps/landing/index.html:289`).                                                                                                                              |
| Add product and use cases     | minor gap      | Headline, three steps, ring, package and three cards match; reduced-motion demo freezes at a different state (G1).                                                                                                                                                                         |
| Voice                         | minor gap      | Copy, example commands, product images and card layout match; reduced-motion demo freezes at a different state (G1).                                                                                                                                                                       |
| Reports                       | gap            | Revenue, profit, top products, digest and closing cards match the source and order; the chart's accessible description contradicts the illustrated data (G2).                                                                                                                              |
| Waitlist and footer           | minor gap      | Both forms have the board's CTA, label, placeholder, invalid and success copy; placeholder contrast is insufficient (G3). Footer copy and layout match.                                                                                                                                    |
| Tokens, typography and motion | minor gap      | White/ink/purple surfaces, product assets, fonts, 1040/720 breakpoints and 1,150 ms cycles correspond (`apps/landing/styles.css:1`, `apps/landing/main.js:177`); reduced-motion state differs (G1).                                                                                        |

The headings and marketing copy were compared with the board section by section; no Vietnamese wording discrepancy was found in the inspected static copy. All illustrative product images use empty alt text, with adjacent product names or illustration descriptions. One h1 precedes the main h2 sections; the enrollment demo also contains an h4 (`apps/landing/index.html:409`). The chart issue and form contrast below are accessibility findings inherited from the board, not visual deviations from it.

Both widgets were exercised at 390×844 with intercepted requests: opening, invalid email and mocked HTTP 200 showed the specified messages. Source inspection covers 422, 429, generic server and network errors, disabled pending button, focus, and Escape (`apps/landing/main.js:16`); those cases were not independently exercised in this audit. The board immediately marks valid input done (`docs/design/canvas/Landing.dc.html:573`), while the site waits for `POST /v1/waitlist` and offers error states; this is an intentional integration distinction, not a failure to copy the mock. The endpoint inserts into the waitlist table (`apps/backend/crates/api/src/waitlist/mod.rs:45`, `apps/backend/migrations/1401_waitlist.sql:1`). No live signup was sent.

## Gaps

### G1 — Reduced-motion demos use different final states

**Severity: minor.** The board freezes the shared tick at 5 (`docs/design/canvas/Landing.dc.html:549`, `:588`, `:596`), giving enrollment 15/24 frames and one visible voice row without the total. The site instead forces enrollment tick 11 and voice tick 8 (`apps/landing/main.js:123`, `:145`), yielding 24/24, the saved overlay and the total. Playwright with reduced motion confirmed `24` and `vtotal on`. Both implementations suppress animation; this is a state fidelity difference.

**Failing Playwright test to add:** `reduced motion preserves the board's tick-five demo states` — emulate reduced motion and assert `[data-frames]` is `15`, `.ringstage` lacks `isSaved`, and `.vtotal` lacks `on`.

### G2 — Chart announces today as the highest day when it is not

**Severity: medium.** `apps/landing/index.html:645` labels the chart “hôm nay cao nhất tuần”, yet the initial today bar is 49% versus Sunday 89% (`:669`, `:673`); the updates at `apps/landing/main.js:154` do not make today the highest either. Screen-reader users receive a false comparison. The same label appears in the board (`docs/design/canvas/Landing.dc.html:479`), so this is an inherited accessibility defect.

**Failing Playwright test to add:** `revenue chart description agrees with its bars` — compare today's bar height with the other six and assert the accessible name says today is highest only when its height is at least every other height.

### G3 — Email placeholder lacks text contrast

**Severity: minor.** The placeholder uses `#8a8a92` (`apps/landing/styles.css:342`) against the open widget's white surface (`:280`), approximately 3.4:1, below 4.5:1 for this 18 px medium-weight text (`:339`). Both waitlist widgets are affected; the board specifies the same color (`docs/design/canvas/Landing.dc.html:62`). The separate input label is present but visually hidden.

**Failing Playwright test to add:** `waitlist placeholders meet normal-text contrast` — open each widget and assert the computed placeholder color against its open background has a contrast ratio of at least 4.5:1.

Gap count: **1 medium, 2 minor; 0 high**. These are three distinct findings, with G1 affecting two sections.
