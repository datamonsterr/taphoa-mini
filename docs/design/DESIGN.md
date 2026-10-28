# Tạp Hóa Mini — App Design

Status: Draft v0.2 · Date: 2026-10-27 · Sources: [docs/PRD.md](../PRD.md),
[assistant spec](../specs/assistant/assistant.md), [voice spec](../specs/voice/voice.md)

The source of truth for the drawn boards is the design canvas v0.2
https://claude.ai/artifact/4V8zoNh4hMuTNzxWNhV5q9, built on the Tạp Hóa Mini design system
(https://claude.ai/artifact/SsJdTA1fdhK5hzfA2Z1Hvi). The v0.1 canvas
https://claude.ai/artifact/2Jcc8NqdW7tt9jDB6RsnXh stays as the 2026-10-23 record. This folder
holds 37 boards: the 32 copied on 2026-10-27, `VoiceSystem.dc.html` and four repo-mirror boards for issue #88. Local V6 additions
(understanding state, credit customer row and system surfaces) are published as canvas version 31.
Screens 22, 25 and 27 have no board; the app code under `apps/mobile/src/features/` is their
reference.

## 1. Principles

- **Camera first.** The app opens on the camera (01). Nothing else shows until the seller acts.
- **Icons and numbers, not words.** Camera screens show icons and prices; other screens use one
  short Vietnamese word per control. Every icon-only control has a Vietnamese label.
- **Seller confirms every write.** Recognition, the assistant and voice never add to the cart
  or record anything by themselves. The seller taps `+`, Confirm or the green check.
- **No new buttons.** New entry points go into the next-step strip or onto an existing
  control (long-press). Existing buttons keep their place.
- **Round, big, thumb-sized.** Circles and pills; tap targets 56 px or larger; prices 32 px or
  larger where a seller reads them to charge.
- **At most three taps from the camera to the VietQR:** `+`, cart pill, QR button. Voice:
  one tap on the bubble, speak, one tap on the check.

## 2. Design tokens

From [canvas/ds/taphoa/tokens.json](canvas/ds/taphoa/tokens.json) and
[tokens.css](canvas/ds/taphoa/tokens.css); component classes `th-*` in
[bundle.css](canvas/ds/taphoa/components/bundle.css). The app mirrors them in
`apps/mobile/src/theme/`.

| Group    | Key values                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces | `surface` #ffffff, `surface-soft` #f3f3f5, `surface-pressed` #e7e7eb                                                                           |
| Text     | `ink` #111114, `ink-muted` #5f5f66, `on-ink` #ffffff                                                                                           |
| Brand    | `accent` #5a43e8 (add-to-cart, selection, focus, chat and voice), `accent-soft` #eeecfd                                                        |
| State    | `success` #18703c, `warning` #a34f00, `danger` #c62f2f, each with a `-soft` ground                                                             |
| Camera   | `camera-bg` #0c0c0e, `camera-ink` #ffffff, `camera-muted` #a1a1a8, `camera-ring` #e2a94b (shutter only)                                        |
| Type     | Be Vietnam Pro. `total` 56/60 800, `price` 32/38 700, `title` 32/38 800, `heading` 22/28 700, `body` 18/26, `label` 18/24 600, `caption` 15/20 |
| Size     | `tap-min` 56, `tap-lg` 64, `tap-xl` 80, `shutter` 88, `icon` 26 (2.25 px stroke)                                                               |
| Radius   | 14 / 22 / 28 / 36 / full                                                                                                                       |

Icons are Lucide line icons (`lucide-react-native` in the app; inline SVG on the canvas).

## 3. Screens

Phone boards are 390×844 (Dashboard 390×1080). Route paths are Expo Router routes under
`apps/mobile/src/app/`.

### Row A — Scan and sell (dark camera surface)

| #   | Board / route                         | Purpose                                            | Controls                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | `Main.dc.html` · `/`                  | Camera, idle. First screen on app open.            | Mode toggle (one / many) top centre · square viewfinder with a short accent barcode bracket and name/price pill (unknown: `Mã vạch · <code>`) · tag button (quick enroll) left · shutter · `+` right (disabled) · **next-step strip** directly under the frame (chips; hidden when empty) · cart pill bottom left · swipe-up handle · **chat button** at the right end of the bottom row (long-press: voice sale) |
| 02  | `Match.dc.html`                       | One item recognized with confidence                | Box with confidence badge · price pill on the box edge · alternatives strip under the viewfinder (takes the strip slot) · `+` active                                                                                                                                                                                                                                                                              |
| 03  | `Multi.dc.html`                       | Many items in one photo                            | One numbered box per segment · price pill per box · `+` with batch count · strip for the tapped price                                                                                                                                                                                                                                                                                                             |
| 04  | `Unknown.dc.html`                     | Top match below the threshold                      | Dashed amber box · "?" pill · tag button pulses · `+` disabled · `unknown_product` chip in the strip                                                                                                                                                                                                                                                                                                              |
| 01b | `ScanDoc.dc.html`                     | Receipt detected (text detection found a document) | Receipt in the frame with one thin accent box per text line and a `Hóa đơn · 12 dòng chữ` badge · strip shows the accent pill `Đọc hóa đơn nhập` (to 19b) and `Nhập trong trợ lý` (to 17) · shutter also reads the receipt · hint line under the controls                                                                                                                                                         |
| —   | (camera state)                        | Quick enroll                                       | Tag toggle on: 3-8 shots, 1-2 tapped points per shot (point overlay: undo, retake, next), quick-enroll sheet `Thêm hàng nhanh · n/min` with name, price, save                                                                                                                                                                                                                                                     |
| 05  | `Enroll.dc.html` · `/enroll`          | Add a product with a price (sheet)                 | Close · captured photo plus angle slots · optional name · optional barcode field (digits 6–20, typed or scan icon) · price · keypad · check · duplicate prompt: merge into an existing product or create anyway                                                                                                                                                                                                   |
| 06  | `Cart.dc.html` · `/cart`              | Cart (sheet over camera)                           | Collapse · count badge · lines with thumbnail, name, price, stepper (trash at 1) · total · QR button                                                                                                                                                                                                                                                                                                              |
| 07  | `Pay.dc.html` · `/pay`                | Payment                                            | Back · title · **three-way toggle with words** chuyển khoản / tiền mặt / ghi nợ · total · VietQR with bank account (transfer) · quick cash chips and change (cash) · thumbnails with quantity and price · green check `Đã nhận tiền` · no bank account → link to 12                                                                                                                                               |
| 07b | `PayCredit.dc.html` · `/pay` (ghi nợ) | Credit sale                                        | Customer row (avatar, name, current debt, phone) with `Đổi` → 07c · `Trả trước` chips 0đ / amount / Khác · new debt line · ink button `Ghi nợ 49.500đ` replaces the green check                                                                                                                                                                                                                                   |
| 07c | `CustomerPick.dc.html` (sheet)        | Choose or create a customer                        | Search by name or phone · recent customers with balance (tap picks) · `Khách mới`: name field, **contact-picker circle** (system picker, one contact, no contacts permission), optional phone · `Tạo và ghi nợ`. Opened from 07b, voice credit (16) and the `+` on 20.                                                                                                                                            |

Barcode (S2/C4): checkout and quick-enroll previews read EAN-13, EAN-8, UPC-A, UPC-E and
Code128. A known code shows the product name and price; the existing `+` confirms adding it
to the cart with source `barcode`. An unknown code opens 05 with the code filled in. Repeat
reads of the same code within two seconds and reads behind a result or sheet are ignored.
The barcode field on 05 and product edit accepts typed digits or a camera scan. A duplicate
keeps the field editable and shows `Mã vạch đã dùng cho <product>`. No viewfinder button is added.

### Row B — Shop (swipe up from the camera)

Bottom bar on 08, 10 and 12: accent camera circle on the left, floating pill with three tabs
Kho, Báo cáo, Tài khoản, and the chat button beside the pill (above its right end on narrow
phones). The low-stock banner can sit above the bar.

| #   | Board / route                       | Purpose                  | Controls                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 08  | `Inventory.dc.html` · `/inventory`  | Product grid             | Handle (swipe down to camera) · title Kho · search toggle and field · 2-column tiles (photo, stock badge, name, price) · segment Sản phẩm / Tồn kho (to 18) · bottom bar                                                                                                                       |
| 09  | `Product.dc.html` · `/product/[id]` | Product detail           | Back · edit price (sheet) · photo carousel · name · price · stock with adjust-stock sheet and low-stock threshold · cost price · recent stock movements                                                                                                                                        |
| 10  | `Dashboard.dc.html` · `/dashboard`  | Reports                  | Add expense · Ngày / Tuần / Tháng chips · stat tiles (revenue with sale count, cash, transfer, expense, net) · 7-day bars · alerts (low stock, price below cost, sold without catalog) · **digest card** (to 23) · **debt card** (to 21) · Hóa đơn nhập (to 19) · Chốt sổ                      |
| 11  | `Expense.dc.html` · `/expense`      | Add expense (sheet)      | Close · bill photo (bill camera) · categories Nhập / Điện / Nước / Khác · Hóa đơn nhập link · amount · keypad · check                                                                                                                                                                          |
| 12  | `Account.dc.html` · `/account`      | Store and settings       | Store picker · members with invite sheet · bank account sheet · PIN: set and switch sheets · device sessions and Thêm người trên máy này · stock threshold row · elder mode · text size · VI / EN · sign out · **Nút nói nhanh section (voice, planned)** · **Góp giọng nói opt-in (planned)** |
| 13  | `Close.dc.html` · `/close`          | End-of-day close (sheet) | Close · expected cash with cash repayments and credit sales lines · counted cash keypad · difference pill (green match, red short, amber extra) · check                                                                                                                                        |

### Row C — Assistant and voice (boards added 2026-10-27)

| #   | Board / route                                           | Purpose                                                              | Controls                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14  | `VoiceBubble.dc.html` · (Android system)                | Voice bubble over the home screen or another app. Not an app screen. | 56 px accent microphone circle with a float shadow at the right edge · draggable, snaps to an edge · tap opens 15 · long-press hides it until the next app open · persistent low-priority notification "Nút nói đang bật" with Tắt (VoiceSystem, §8). Enabled from 12 ("Hiện nút nói trên màn hình" → system Settings "Hiện trên ứng dụng khác"). No accessibility service.                                                                   |
| 15  | `VoiceListen.dc.html` · `/voice`                        | Listening and understanding (translucent modal)                      | Close · 88 px accent microphone with a pulse ring · level bars · 30 s countdown · hint "Nói tên hàng và giá" · big stop button (tap-to-stop from the bubble; hold-to-talk inside the app). Xong → “Đang hiểu…” with large grey transcript, progress line and Hủy (canvas: tap progress to draft).                                                                                                                                             |
| 16  | `VoiceSale.dc.html` · `/voice` (draft)                  | Voice sale sheet                                                     | Transcript in quotes · lines like the cart with a status chip on the thumbnail: green check matched, amber "?" ambiguous (tap: three-candidate strip), grey tag unknown (manual line at the spoken price; tap: catalog search) · price pill red on mismatch · stepper · total · payment toggle tiền mặt / chuyển khoản / ghi nợ (credit: 07b customer row with matched name / Đổi, or Chọn khách → 07c) · microphone (add more) · green check |
| 17  | `Assistant.dc.html`, `ChatVoice.dc.html` · `/assistant` | Assistant chat (full-height sheet) with the microphone held          | Header Trợ lý · thread list toggle · new chat · close · streamed messages, tool status lines, cards (restock list, debt list, chart bars, receipt lines), proposed-action card with Xác nhận / Từ chối, thumbs up / down · composer: input, **hold-to-talk microphone** (server transcription, on-device offline; fills the input, never sends), send                                                                                         |

Entry points to 15: the bubble (14), a Quick Settings tile "Bán hàng", the app shortcut,
the iOS Control Center control, Action Button and Siri, long-press on the chat button, and the
`voice_sale` next-step chip. Confirm from the bubble returns to the previous app. `FlowVoice.dc.html` draws the voice path of §5 as a board;
`Assistant.dc.html` shows the chat in text mode (restock card, proposed action) and
`ChatVoice.dc.html` the same sheet with the microphone held.

### Row D — Stock, receipts, debts, digest (implemented; boards added 2026-10-27)

| #   | Route                                            | Purpose                       | Controls                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 18  | `Stock.dc.html` · `/stock`                       | Stock list                    | Back · segment Sản phẩm / Tồn kho · filters Tất cả / Sắp hết / Hết hàng / Còn hàng · rows to 09                                                                                                                                                                                                                                                                                |
| 19  | `Receipt.dc.html` · `/receipts`, `/receipt/[id]` | Import receipt: confirm       | History list · review: photo, lines with product chips, total, payment source, linked expense, `Xác nhận nhập kho`, `Bỏ bản nháp`                                                                                                                                                                                                                                              |
| 19b | `ReceiptEdit.dc.html` · `/receipt/[id]` (adjust) | OCR lines as an editable list | Header with the fix count · photo strip · one card per line: product name (tap to change), status chip `Khớp` / `Chọn sản phẩm` / `Giá chưa rõ`, the OCR text, trash, **quantity stepper**, **unit price pill (tap opens the keypad)**, line total · `Thêm dòng` · total with item count · `Xong, xem lại` (to 19). Interactive: stepper, delete and keypad work on the canvas |
| 20  | `Debts.dc.html` · `/debts`                       | Debt book                     | Back · **add-customer circle** (to 07c) · total and overdue · search · overdue chip · customer list                                                                                                                                                                                                                                                                            |
| 21  | `Customer.dc.html` · `/customer/[id]`            | Customer                      | Balance · collect (repayment sheet) · adjust (Lead) · edit or archive · ledger                                                                                                                                                                                                                                                                                                 |
| 22  | low-stock banner                                 | Alert over the shop tabs      | message · Xem tồn kho · dismiss                                                                                                                                                                                                                                                                                                                                                |
| 23  | `Digest.dc.html` · `/digest`                     | Morning digest                | Summary, revenue, sale count, profit, restock list, drafts (to 19), debts (to 20), Hỏi trợ lý (to 17)                                                                                                                                                                                                                                                                          |

### Row E — Sign-in and onboarding (implemented; boards added 2026-10-27)

| #   | Route                                              | Purpose             | Controls                                                                                            |
| --- | -------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| 24  | `SignIn.dc.html` · `/sign-in`, `/verify-code`      | Clerk sign-in       | Email · captcha · send code · Google · six-digit code · resend · change email · PIN sheet to switch |
| 25  | `/add-person/*`                                    | Add a second person | Same as 24 with cancel                                                                              |
| 26  | `Welcome.dc.html` · `/welcome`, `/create`, `/join` | Onboarding          | Create store (name, display name, bank) · join with invite token · sign out                         |
| 27  | PIN lock (sheet, no route)                         | Shared-phone lock   | PIN entry over the gate on cold start                                                               |

## 4. Camera interaction spec

1. **Mode toggle** (top centre): one item or many. It changes how results draw, not which
   buttons show.
2. **Shutter** captures and sends the photo; the server segments it and matches each crop.
3. **Box per detected product.** Tap to select or deselect. Selected: white border, accent
   glow, accent number badge (multi). Deselected: dashed white border, empty badge ring.
4. **Price pill on the box edge** shows the top-1 price. Tap it to open the alternatives
   strip (top-1 first with an accent ring, then look-alikes). Choosing one replaces the price
   and selects the box. Single mode: the strip takes the strip slot under the viewfinder;
   multi: it floats inside the viewfinder.
5. **Low confidence**: dashed amber box, "?" pill, pulsing tag button, `+` disabled; enroll
   first. The `unknown_product` chip offers the same.
6. **Next-step strip**: one row of chips under the frame, snap scrolling, haptic on tap,
   hidden when empty; it never changes existing buttons. Chips come from the camera state
   (`receipt_detected`, `unknown_product`) and the server rules (`restock`, `draft_receipts`,
   `overdue_debts`, `day_close`, `review_queue`, `digest`, `setup`, `margin_alert`, and
   `voice_sale` once the voice program lands).
7. **`+`** adds all selected boxes; its badge shows the batch count. **Cart pill** opens the
   cart. **Swipe-up handle** opens the shop (08). **Chat button** opens the assistant (17);
   long-press opens the voice sale (15).

## 5. Flows

```
Camera ─► segment + match ─► score ≥ threshold?
   │                               yes ─► box + price ─► + ─► Cart ─► Pay (QR / cash / credit) ─► sale logged
   │                               no  ─► low match ─► Enroll ─► Cart
   ├─(receipt detected)─► receipt in chat (17) or receipt review (19) ─► stock added
   ├─(swipe up)─► Shop: Inventory ─► Product · Dashboard ─► Expense / Chốt sổ / Digest / Debts · Account
   ├─(chat button)─► Assistant (17) ─► read tools ─► proposed action ─► Confirm
   └─(long-press chat button)─┐
Bubble / tile / control / Siri ┴─► Voice listen (15) ─► server parse ─► Voice sale (16) ─► Confirm ─► sale logged
                                                                          └─ chuyển khoản ─► Pay (07)
```

## 6. Components

Camera surface: mode toggle (one / many) · shutter · enroll tag circle (normal, pulse) · add
`+` (disabled, active, with batch badge) · cart pill (empty, count and total) · swipe handle ·
detection box (selected with number, deselected, low match) · price pill (selected, deselected,
unknown "?") · alternatives chip (current, alternative) · next-step chip (camera, server) ·
document button · chat button.

Light surface: camera circle and nav pill (3 tabs, current filled) · chat button (56 px accent,
beside or above the pill) · back / edit / search / close circles · stepper (trash at 1) ·
keypad key (digit, 000, delete) · QR pill · pay toggle (transfer / cash / credit) · received
or save check (success fill, ink fill) · stock badge (normal, low) · period chip · switch ·
alert pill · difference pill (match, short, extra) · digest card (new badge) · debt card ·
customer picker sheet (search, recent, new customer with the contact-picker circle) ·
low-stock banner · PIN sheet · customer picker · proposed-action card (Xác nhận / Từ chối, Chờ
xác nhận) · feedback thumbs.

Voice (planned): voice bubble (idle, dragging, hidden) · listening microphone (idle 56 px in
the composer; 88 px accent with a pulse ring while listening; disabled with hint when no
recognition) · level bars · countdown ring · draft line status chip (matched green, ambiguous
amber "?", unknown grey tag) · candidate strip (three chips) · price-mismatch pill · "Hỏi trợ
lý" hand-off when the words were a question.

## 7. PRD and spec coverage

| Requirement                                              | Where                         |
| -------------------------------------------------------- | ----------------------------- |
| C1 photo + price enroll; quick enroll                    | 05, camera quick-enroll state |
| C3 edit price; E4 stock, threshold, movements            | 09, 18                        |
| C6 price list grid                                       | 08                            |
| S1 top match + alternatives; S4 unknown; S8 multi        | 02, 04, 03                    |
| S5 cart; S6 pay cash / transfer / credit (debt book U23) | 06, 07, 20, 21                |
| E1 expense with bill photo; import receipts              | 11, 19                        |
| E3 price below cost alert; low-stock alert               | 10 alerts, 22                 |
| R1 today, R3 bars, R2 chốt sổ                            | 10, 13                        |
| U1 join by invite, U2 roles, Clerk sign-in, PIN lock     | 12, 24-27                     |
| T1 bank account; T2 elder mode, text size; T3 language   | 12                            |
| Assistant U1-U23, next-step strip, daily digest          | 17, 01 strip, 23              |
| Voice sale V-U1..V-U5, voice chat V-U6                   | 14-17                         |

### Issue #88 repo-mirror additions

| #   | Board / route                       | Controls                                                                                                                 |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 28a | `RecentSales.dc.html` · `/sales`    | Báo cáo entry; paginated recent sales, completed/voided status; loading, empty, retry                                    |
| 28  | `SaleDetail.dc.html` · `/sale/[id]` | Sale lines, total, payment, status; Lead-only reason and confirmation; full void/refund, error/retry and recorded reason |
| 29  | `Export.dc.html` · Báo cáo sheet    | Inclusive date range and CSV/XLSX; download and system share, pending/error; browser download fallback                   |
| 09b | `ProductUnits.dc.html` · product 09 | Lead-only add/edit/delete extra units, quantity in base and price; cart/payment unit choices                             |

These are repository designs for S10, R5 and C5; they are not a claim that the external canvas was updated.
Unit writes replace `ProductPatch.units`. The base price remains on product 09. Full voids use the existing backend transaction; there is no partial-refund endpoint.

## 8. System surfaces and remaining boards

- Boards for 22 (low-stock banner), 25 (add a person) and 27 (PIN lock); the code is the
  reference.
- Elder-mode variants, TTS (S7).
- `VoiceSystem.dc.html`: Android persistent “Nút nói đang bật” notification with “Tắt”,
  Quick Settings tile “Bán hàng”, and iOS Control Center control (both open 15).

## 9. Files

```
docs/design/
  DESIGN.md                this file
  canvas/
    canvas.json            board layout, titles, notes, design-system record
    *.dc.html              one file per board (37)
    ds/taphoa/             copy of the design system: tokens.json, tokens.css, components/bundle.css
```

The `.dc.html` files are in the Design Component format and need the canvas runtime
(`support.js`, served by the canvas), so they do not render on their own. Open the canvas link
to view or edit them. To build the app, take values from `tokens.css` and the layout, sizes and
states from the boards and this document.
