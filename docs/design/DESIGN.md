# Tạp Hóa Mini — App Design

Status: Draft v0.1 · Date: 2026-10-23 · Source: [docs/PRD.md](../PRD.md)

The source of truth is the design canvas https://claude.ai/artifact/2Jcc8NqdW7tt9jDB6RsnXh, which uses the Tạp Hóa Mini design system (https://claude.ai/artifact/SsJdTA1fdhK5hzfA2Z1Hvi). This folder holds a copy of the canvas taken on 2026-10-23.

## 1. Principles

- **Camera first.** The app opens straight to the camera (screen 01). Nothing else shows until the seller acts.
- **Icons and numbers, not words.** Camera screens show only icons and prices. Other screens use one short Vietnamese word at most per control. Every icon-only control has a Vietnamese `aria-label`.
- **Seller confirms every line.** Recognition never adds to the cart by itself. The seller taps `+`.
- **No extra buttons.** Every control on every screen maps to a PRD requirement (see §7).
- **Round, big, thumb-sized.** Buttons are circles or pills. Tap targets are 56px or larger. Prices are 32px or larger where a seller reads them to charge.
- **At most three taps from the camera to the VietQR:** `+`, then the cart pill, then the QR button.

## 2. Design tokens

Tokens come from the Tạp Hóa Mini design system: [canvas/ds/taphoa/tokens.json](canvas/ds/taphoa/tokens.json) and [tokens.css](canvas/ds/taphoa/tokens.css). Component classes (`th-*`) are in [bundle.css](canvas/ds/taphoa/components/bundle.css).

| Group    | Key values                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces | `surface` #ffffff, `surface-soft` #f3f3f5, `surface-pressed` #e7e7eb                                                                           |
| Text     | `ink` #111114, `ink-muted` #5f5f66, `on-ink` #ffffff                                                                                           |
| Brand    | `accent` #5a43e8 (add-to-cart, selection, focus), `accent-soft` #eeecfd                                                                        |
| State    | `success` #18703c, `warning` #a34f00, `danger` #c62f2f, each with a `-soft` ground                                                             |
| Camera   | `camera-bg` #0c0c0e, `camera-ink` #ffffff, `camera-muted` #a1a1a8, `camera-ring` #e2a94b (shutter only)                                        |
| Type     | Be Vietnam Pro. `total` 56/60 800, `price` 32/38 700, `title` 32/38 800, `heading` 22/28 700, `body` 18/26, `label` 18/24 600, `caption` 15/20 |
| Size     | `tap-min` 56, `tap-lg` 64, `tap-xl` 80, `shutter` 88, `icon` 26 (2.25px stroke)                                                                |
| Radius   | 14 / 22 / 28 / 36 / full                                                                                                                       |

The design system has no icon set. The canvas uses Lucide-style line icons drawn inline (24×24 viewBox, round caps). Product photos on the canvas are drawn placeholders, not real product images.

## 3. Screens

All phone screens are 390×844, except Dashboard, which is 390×1080 and scrolls.

### Row A — Scan and sell (dark camera surface)

| #   | File              | Purpose                                           | Controls                                                                                                                                                                            |
| --- | ----------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | `Main.dc.html`    | Camera, idle. First screen on app open.           | Mode toggle (one / many), centred at top · square viewfinder · tag button (enroll) on the left · shutter · `+` on the right (disabled) · cart pill at bottom left · swipe-up handle |
| 02  | `Match.dc.html`   | Single item recognized with high confidence       | Box around the product with a confidence badge · **price pill on the box edge** · alternatives strip under the viewfinder · `+` active (accent)                                     |
| 03  | `Multi.dc.html`   | Many items in one photo                           | One box per segment, each with a number badge 1, 2, 3… · price pill per box · `+` shows the batch count · strip opens for the price you tap                                         |
| 04  | `Unknown.dc.html` | Top match below the threshold                     | Dashed amber box · "?" pill on the box · tag button pulses, with an arrow pointing to it · `+` disabled                                                                             |
| 05  | `Enroll.dc.html`  | Add a product to the catalog with a price (sheet) | Close · captured photo plus "add angle" slot (1/5) · optional name field · price display · keypad · check (save and add to cart)                                                    |
| 06  | `Cart.dc.html`    | Cart (sheet over camera)                          | Collapse · item count badge · lines with thumbnail, name, price and stepper (at quantity 1 the minus becomes a trash icon) · total · QR button                                      |
| 07  | `Pay.dc.html`     | Payment                                           | Back · transfer/cash toggle · total · VietQR with bank account (transfer) or quick cash notes with change (cash) · item thumbnails with quantity and price · green check (received) |

### Row B — Shop (swipe up from the camera)

| #   | File                | Purpose                  | Controls                                                                                                                                                                                         |
| --- | ------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 08  | `Inventory.dc.html` | Product grid             | Handle (swipe down to camera) · title "Kho" · search · 2-column tiles (photo, stock badge, name, price) · bottom bar                                                                             |
| 09  | `Product.dc.html`   | Product detail           | Back · edit price · photo carousel dots · name · price · stock · cost price · description                                                                                                        |
| 10  | `Dashboard.dc.html` | Reports                  | Add expense · Ngày/Tuần/Tháng chips · revenue with sale count · cash, transfer, expense, net · 7-day revenue/expense bars · alerts (low stock, price below cost, sold without catalog) · Chốt sổ |
| 11  | `Expense.dc.html`   | Add expense (sheet)      | Close · photo of bill · categories Nhập / Điện / Nước / Khác · amount · keypad · check                                                                                                           |
| 12  | `Account.dc.html`   | Store and settings       | Store and role · family members with invite QR · bank account for VietQR · elder-mode switch · text size · VI / EN                                                                               |
| 13  | `Close.dc.html`     | End-of-day close (sheet) | Close · expected cash · counted cash (keypad) · difference pill (green when it matches, red when cash is short, amber when there is extra) · check                                               |

**Bottom bar** on screens 08, 10 and 12: an accent camera-scanner circle on the left that opens screen 01, and a floating pill with three tabs: Kho, Báo cáo, Tài khoản.

### Row C — Reference

- `Flow.dc.html`: the flow diagram (§5).
- `Components.dc.html`: every button and its states (§6).

## 4. Camera interaction spec

1. **Mode toggle** (top centre): one item or many items. It changes how results are drawn, not which buttons show.
2. **Shutter**: captures the photo and sends it to the server, which segments it (SAM) and matches each crop by embedding (PRD §3.2, §9).
3. **Box per detected product.** Tap the box to select or deselect it.
   - Selected: white border, accent glow, accent number badge (multi mode).
   - Deselected: dashed white border, empty badge ring.
4. **Price pill on the box edge** shows the top-1 match price. Tap the price to open a **horizontal swipe strip**: the top-1 match comes first with an accent ring, then the alternatives (look-alike flavours and sizes). Choosing one replaces the price on the box and selects the box. Tap the price again to close the strip.
   - Single mode: the strip sits between the viewfinder and the controls.
   - Multi mode: the strip floats inside the viewfinder, below the box (or above it when there is no room).
5. **Low confidence** (top-1 below the threshold): the box turns dashed amber, its pill shows "?", the tag (enroll) button pulses and `+` is disabled. The seller must enroll the product before it can be sold. Tapping the "?" pill also opens enroll.
6. **`+`**: adds all selected boxes to the cart. Its badge shows the batch count.
7. **Cart pill** (bottom left): count badge and running total. Tap it to open the cart.
8. **Swipe-up handle**: opens the shop (screen 08).

The threshold value and the top-k count (3 by default) are server settings, not part of the UI.

## 5. Flows

```
Camera ─► Segment + match ─► score ≥ threshold?
                                   │ yes ─► Box + price (tap box / tap price) ─► + Add ─► Cart ─► VietQR ─► Sale logged
                                   │ no  ─► Low match ─► Enroll (photo + price) ─► Cart
Camera ─(swipe up)─► Shop ─► Product
                          └► Dashboard ─► Expense sheet / Chốt sổ sheet
                          └► Account
```

The prototype links on the canvas follow this flow. Open the canvas and press Play on any phone board.

## 6. Components

The camera surface:

| Component               | States                                                    |
| ----------------------- | --------------------------------------------------------- |
| Mode toggle             | one / many                                                |
| Shutter                 | —                                                         |
| Enroll (tag) circle     | normal, pulse (low match)                                 |
| Add `+` circle          | disabled, active, active with batch badge                 |
| Cart pill               | empty (0), count and total                                |
| Swipe handle            | —                                                         |
| Detection box           | selected with number, deselected, low match               |
| Price pill              | selected (white), deselected (dark), unknown ("?", amber) |
| Alternatives strip chip | current top-1 (accent ring), alternative                  |

The light surface:

| Component                         | States                                    |
| --------------------------------- | ----------------------------------------- |
| Camera FAB and nav pill           | 3 tabs, current tab filled ink            |
| Back, edit, search, close circles | —                                         |
| Stepper                           | minus becomes trash at quantity 1         |
| Keypad key                        | digit, 000, delete                        |
| QR pill                           | —                                         |
| Pay toggle                        | transfer / cash                           |
| Received / save check             | success fill (received), ink fill (save)  |
| Stock badge                       | normal, low (amber with alert icon)       |
| Period chip                       | pressed / not pressed                     |
| Switch                            | on / off                                  |
| Alert pill                        | amber with count                          |
| Difference pill                   | match (green), short (red), extra (amber) |

## 7. PRD coverage

| PRD                                                      | Where                                                 |
| -------------------------------------------------------- | ----------------------------------------------------- |
| C1 photo + price enroll, 1–5 photos, name optional       | 05                                                    |
| C3 edit price                                            | 09 edit circle                                        |
| C6 price list grid                                       | 08                                                    |
| S1 camera, top match + alternatives, confirm to add      | 02, 04                                                |
| S3 grid mode                                             | 08 (tiles); the add-from-grid action is not yet drawn |
| S4 unknown item                                          | 04 to 05                                              |
| S5 cart with ± and running total                         | 06, cart pill on 01–04                                |
| S6 pay: cash / transfer, change, VietQR                  | 07                                                    |
| S8 multi-item photo                                      | 03                                                    |
| E1 expense with category and bill photo                  | 11                                                    |
| E3 price below cost alert                                | 10 alert pill                                         |
| E4 stock quantity                                        | 08 badge, 09                                          |
| R1 today: revenue, sales, cash vs transfer, expense, net | 10                                                    |
| R2 end-of-day close                                      | 13                                                    |
| R3 day / week / month bars                               | 10                                                    |
| U1 join by store QR, U2 roles                            | 12                                                    |
| T1 bank account for VietQR                               | 12, shown on 07                                       |
| T2 elder mode, font scale                                | 12                                                    |
| T3 language                                              | 12                                                    |

## 8. Not drawn yet

- Duplicate prompt on enroll ("Same as X?", C2) and price history (C3).
- Grid-mode add-to-cart for elders (S3) and the elder-mode variants of the screens.
- Barcode match indicator (S2), TTS button (S7), void/refund (S10).
- Search results, flagged manual-price review list, and CSV export (R5).
- Onboarding (F1) and the success state after payment.

## 9. Files

```
docs/design/
  DESIGN.md                this file
  canvas/
    canvas.json            board layout, titles, notes, design-system record
    *.dc.html              one file per board (15)
    ds/taphoa/             copy of the design system: tokens.json, tokens.css, components/bundle.css
```

The `.dc.html` files are in the Design Component format. They need the canvas runtime (`support.js`, served by the canvas), so they do not render on their own in a browser. To view or edit them, open the canvas link above. To build the app, take values from `tokens.css` and the layout, sizes and states from the board files and this document.
