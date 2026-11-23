# ADR 0012: One place for each shop task

Status: Accepted · Date: 2026-11-23 · Design: [Navigation — November 2026](../design/navigation-2026-11.md)

## Context

The primary user is an elderly Vietnamese shopkeeper using an inexpensive Android phone.
Recognizing where to go matters more than saving a small amount of processing time. The
November roadmap identifies overlapping inventory, stock and receipt entry points, a
Dashboard acting as a feature menu, and a long cash checkout.

The route audit finds 27 screen files and five navigator layouts under
`apps/mobile/src/app`, rather than the roadmap's 22 routes. Stock is pushed from the
inventory segment. Receipt history, review and the stock restock action lead through
different surfaces. Cash checkout takes five taps after a recognized scan, or six when
choosing a tendered note.

Owner decision **D4**, as resolved in the X1 task instruction, authorizes the agent to write
the navigation note and proceed without waiting for another approval. This supersedes the
roadmap X1 row's pending owner-approval wording. D3 fixes the report scope; D5 fixes the
elder-mode onboarding default.

## Decision

1. Keep three familiar tabs: **Kho** (`Package`), **Báo cáo** (`ChartColumn`) and
   **Tài khoản** (`User`). Kho contains Sản phẩm and Tồn kho segments without pushing a
   stock screen. `/stock` becomes a replace-only compatibility alias to the stock segment.
2. Put **Nhập hàng** in Kho. `/receipts` owns history, photo capture, editable review and
   intake confirmation as one flow. `/receipt/:id` replaces into that flow with its ID.
   Show totals, payment and stock effects in the review; remove the separate preview step.
   Existing receipt confirmation still records the purchase expense and stock together.
3. Give Báo cáo one daily row: **Chi · Chốt sổ · Công nợ**, each one tap away. Include
   top-products; exclude recognition report and price-list export from the app (D3).
   Preserve recent sales and transaction export. Move the shop assistant to the Báo cáo
   header; keep contextual assistant help. Keep the shared camera action and give the
   camera footer a visible Nói action. The optional system voice bubble remains optional.
4. Group account settings into **Cửa hàng**, **Dễ sử dụng** and collapsed **Nâng cao**.
   Keep every current option and permission, including devices, PIN and voice setup;
   keep sign-out visible. Bank deep links expose their group.
5. Confirming one certain scan into an empty cart opens Pay with Cash selected. Keep Cash
   and QR visible on Cart for other sales. Retain final payment confirmation, credit,
   change, corrections and offline idempotency; target at most four cash taps after the
   shutter. Do not change direct/voice-transfer Pay's default to cash.
6. Ask for elder mode once in create/join onboarding, default ON (D5), persist the choice
   on the device and retain the account switch. Extend existing size/speech support to the
   new navigation and flows; ON starts at Kho/Sản phẩm, OFF at the camera. Explicit
   deep links take priority over either launch preference.

The design note specifies every route's fate, exact tap-count assumptions, external-link
contracts and file/test ownership for X2–X6. It is the implementation reference; those tasks
update their design boards and tests before changing the app.

## Consequences

- The information architecture has fewer competing entry points while retaining familiar
  tab names, product adjustments, reporting and account capabilities.
- Old stock/receipt URLs remain valid through small alias routes. Digest push and voice
  bubble/tile URLs retain their parameters and return behavior. Alias navigation must not
  add Back steps or bypass authentication, membership, PIN or role guards.
- The eligible single-item sale bypasses Cart but never confirmation. Multi-item and
  correction flows retain Cart, avoiding an implicit sale or loss of existing lines.
- Report loading must not hide daily actions. Receipt loading/errors must preserve drafts;
  one review screen must still make stock and cost corrections clear.
- Shared navigation files constrain parallel work: X2 and X4 can start together, then X3,
  X5 and X6 integrate in that order. Default-ON elder mode changes shared test setup that
  currently expects the camera after creating a store.
- Real-device checks remain necessary for large text on narrow screens, notification
  launches and returning from the system voice bubble. They do not block accepting D4.
