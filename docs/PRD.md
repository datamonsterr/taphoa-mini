# Tạp Hóa Mini — Product Requirements Document

Status: Draft v0.1 · Date: 2026-10-23 · Owner: datamonsterr

## 1. Summary

Tạp Hóa Mini is a phone-first point-of-sale app for small family-run convenience stores (tiệm tạp hóa) in Vietnam. A shopkeeper photographs items on the counter. The app recognizes them, shows the total, and displays a VietQR code with the exact amount. Every sale is logged automatically, so the family no longer depends on one person's memory of prices or on carton-scrap notes for end-of-day reconciliation.

The core bet: **enrolling a product must take one photo and one price, with no barcode, no SKU form, and no typing required.** Existing POS products fail this store because setup and daily operation are too heavy.

## 2. Problem analysis

### 2.1 Current process (as-is)

1. Customer picks items and puts them on the counter.
2. Whoever is at the counter recalls each price from memory, adds them up (mentally or on paper).
3. Customer pays cash or transfers via a static bank QR.
4. The seller notes the sale on a piece of carton (sometimes).
5. End of day: mom adds up the notes and compares with the cash box.

### 2.2 Root causes

| # | Symptom | Root cause | Impact |
|---|---|---|---|
| P1 | Non-lead family members (son, grandma, dad) must ask mom for prices | Price knowledge lives in one person's head | Lead is interrupted constantly; slow checkout; others avoid watching the store |
| P2 | Wrong prices charged after supplier cost increases | No shared, current price list; price changes are not propagated | Lost margin (undercharging) or customer disputes (inconsistent prices) |
| P3 | End-of-day totals do not match the cash box | Logging is manual and optional; transfers and cash are mixed | No trust in numbers; unknown leakage; no real profit picture |
| P4 | Existing tools are rejected | POS systems need a PC, scanner, printer, speaker, barcode setup, and training | Store stays on paper; elderly users excluded |
| P5 | No view of income, expenses, profit | Purchases (nhập hàng) are not recorded alongside sales | Owner cannot tell which products or periods make money |

P1 and P2 are the daily pain. P3 and P5 are the value that grows over time. P4 is the constraint every design decision must respect.

### 2.3 External driver: tax regime change

Vietnam is abolishing the presumptive lump-sum tax (thuế khoán) for household businesses (hộ kinh doanh) from 2026 and moving them to self-declaration based on actual revenue, with e-invoice / cash-register requirements phased in by revenue tier (Decree 70/2025/ND-CP and related guidance). Many tạp hóa will soon need a basic, accurate sales record whether they want one or not.

> Action: verify the exact thresholds and effective dates against current General Department of Taxation guidance before using this in marketing or scoping compliance features.

This turns "nice-to-have bookkeeping" into a likely need, and is the strongest adoption argument after P1.

### 2.4 Users

| Persona | Description | Needs | Constraints |
|---|---|---|---|
| **Lead (Mom)** | Knows all prices, sets prices, handles buying stock | Set and change prices once; see daily totals; stop being interrupted | Busy; moderate smartphone skill |
| **Helper (Son)** | Watches store sometimes, knows no prices | Get the right price instantly without asking | Tech-comfortable; low product knowledge |
| **Elder (Grandma)** | Watches store occasionally | Very large text, few buttons, Vietnamese only, ideally spoken total | Poor eyesight; low tech literacy; may not read small text |
| **Customer** | Buys a few items | Fast checkout; correct price; easy transfer | Expects to pay by scanning a QR in their banking app |

## 3. Solution validation

The proposed solution has four parts. Each is assessed for whether it solves a real problem and whether it is feasible.

### 3.1 Photo enrollment with price (few-shot product catalog) — **Validated, core**

Idea: photograph a product, enter its price (name optional), and the app learns it.

- Solves P1 and P2 directly: price knowledge moves from mom's head into a shared catalog that mom controls.
- Lower setup cost than barcode-based POS: many tạp hóa items are loose, repacked, local, or have no usable barcode (eggs, bánh, loose candy, local snacks).
- Feasible technique: do **not** train a custom YOLO classifier per store. Use a pretrained image-embedding model (e.g. DINOv2 / CLIP / MobileNet-class embedding) and store 1–5 reference embeddings per product. Recognition is nearest-neighbor search. Adding a product means storing a vector, with no retraining.
- Duplicate detection (the user's idea) falls out naturally: if a new photo's embedding is very close to an existing product, ask "Is this the same as *Aquafina 500ml — 5.000đ*?"

Risks:

- **Look-alike variants** (same brand, different flavor or size: Lavie 350ml vs 500ml, Hảo Hảo tôm chua cay vs gà). This is the biggest accuracy risk because these items often have *different prices*. Mitigation: always show the top match with its photo so the seller confirms visually; show alternatives one tap away; let enrollment capture several angles.
- Lighting and counter clutter. Mitigation: enrollment and checkout photos on the same counter, same phone.

### 3.2 Multi-item detection on the counter — **Validated with conditions; phase 2**

Idea: one photo of all items spread on the counter, detect each item, sum the total.

- Delivers the "wow" experience and the fastest checkout.
- Technically harder than single-item recognition: needs class-agnostic object detection/segmentation (e.g. YOLO-World, a YOLO generic "object" detector, or SAM-family segmentation) to crop each item, then embedding match per crop.
- Failure modes: overlapping/stacked items, multiple identical items (counting 3 cans of Coca), small items (gum, candy), items in a plastic bag. A missed or double-counted item is a **wrong charge**, which is exactly the problem we are solving.
- On-device latency for segmentation models on low-end Android phones may be several seconds; cloud inference adds network dependency.

Conclusion: phase 1 runs multi-item detection with **no training**: a pretrained SAM model on the server segments the counter photo, and each crop is matched by embedding similarity. SAM also segments background, hands, and bags, so crops need filtering (size, position, match score). Single-item scan stays available for crowded counters. Phase 2 fine-tunes YOLO on the photos collected in phase 1, which addresses the failure modes above with real data. Every detected item must appear as an editable line (photo thumbnail + price + quantity ±) before the total is final. The seller confirms; the model never charges silently.

### 3.3 Total screen + dynamic VietQR — **Validated, high value, low cost**

Idea: tap total, show a QR code for the exact amount.

- VietQR (NAPAS 247) supports QR codes that embed bank account, amount, and memo. Any Vietnamese banking app can scan and pay. The QR can be generated offline from the store's bank account details, with no payment-gateway contract.
- Removes typing errors in transfer amounts and makes the memo carry an order ID for reconciliation.
- Replaces the separate "loa thông báo" (payment speaker) only partially: confirming that money *arrived* requires a bank notification integration (bank API, webhook provider such as Casso/SePay-type services, or reading bank notifications). MVP: seller taps "Paid — cash" or "Paid — transfer" manually. Phase 2: automatic transfer confirmation.

### 3.4 Sales + expense log, reports — **Validated, grows in value**

Idea: every sale is stored; purchases/expenses entered in-app; daily/weekly/monthly views.

- Solves P3 and P5 and supports the tax driver (2.3).
- Must stay effortless: sales are logged automatically by checkout; expense entry is "photo of supplier receipt + amount", category optional.
- Cost price per product enables margin and "price is now below cost" warnings, which addresses P2 directly: when mom records a purchase at a higher cost, the app flags products whose selling price no longer covers it.

### 3.5 Alternatives considered

| Alternative | Verdict |
|---|---|
| Existing POS (KiotViet, Sapo, MISA eShop, iPOS) | Feature-rich but barcode/SKU-centric, subscription-priced, and setup-heavy. Fails P4 for this segment. Main competitive reference. |
| Barcode scanning via phone camera | Cheap, very accurate for packaged goods. Weak for loose/local items and requires a barcode for every product. **Include as a secondary input**: if a barcode is visible, use it as a high-confidence key alongside the image. |
| Printed price list / price stickers | Zero tech, partially solves P1. Fails P2 (stale lists) and P3/P5. Useful as an export ("print price list") feature. |
| Photo grid "menu" (tap the picture of the item, no camera) | Very robust, elder-friendly, works offline with no ML. **Include as fallback** and as the primary mode for Grandma. |

### 3.6 Validation verdict

The problem is real and the solution fits it. Adjustments to the original idea:

1. Lead with **photo + price catalog** and **recognition with visual confirmation of every line**.
2. Phase 1: **pretrained SAM + embedding similarity**, no training. Phase 2: **fine-tuned YOLO** on collected store data.
3. Provide **three input paths** to the same cart: camera recognition, barcode (if present), photo grid tap. Any family member uses whichever works for them.
4. **Human confirms every line**; the app never charges a number the seller did not see.
5. Price changes are owned by the lead role and propagate instantly to every device.

### 3.7 Assumptions to test before/while building

| ID | Assumption | How to test | Pass signal |
|---|---|---|---|
| A1 | Top-1 recognition with confirmation is correct often enough to be faster than asking mom | Enroll 50 real products in the family store; run 200 checkout scans | ≥90% top-1, ≥98% top-3; median ≤3 s per item |
| A2 | Lead will enroll the catalog | Time enrollment of 50 products | ≤15 s per product; lead completes 50 in one sitting |
| A3 | Elders can use photo-grid mode | Grandma completes 5 checkouts unassisted after one demo | 4 of 5 correct totals |
| A4 | Family logs every sale when it is automatic | Compare app daily total with cash box for 2 weeks | Discrepancy <2% of daily revenue |
| A5 | Other tạp hóa owners want this | Show prototype to 10 nearby stores | ≥5 willing to try free; ≥2 willing to pay |

## 4. Goals and non-goals

### Goals (MVP)

- G1: Anyone in the family can find the correct current price of an enrolled item in ≤3 s without asking.
- G2: Checkout of a 5-item basket in ≤30 s, with total and VietQR shown.
- G3: Every sale recorded automatically; daily totals split by cash vs transfer.
- G4: Lead changes a price once; all devices use it immediately (or on next sync if offline).
- G5: Runs on one mid/low-range Android phone. No PC, scanner, printer, or speaker required.

### Non-goals (MVP)

- Full inventory/stock counts and reorder alerts (phase 2–3).
- Training or fine-tuning any model (phase 2).
- Automatic bank transfer confirmation (phase 2).
- E-invoice issuance / tax filing integration (phase 3, after regulation review).
- Multi-store chains, loyalty, customer accounts, delivery.
- Receipt printing (optional later via Bluetooth printer).

## 5. Functional requirements

Priority: **P0** = MVP must, **P1** = MVP should, **P2** = later.

### 5.1 Catalog (Danh mục hàng)

| ID | Requirement | Priority |
|---|---|---|
| C1 | Add product: take 1–5 photos, enter selling price (numeric keypad, đ). Name optional. | P0 |
| C2 | On add, if a photo matches an existing product above a similarity threshold, prompt "Same as X?" with photo; choose merge (adds as extra reference photo) or create new. | P0 |
| C3 | Edit price; keep price history (old price, new price, who, when). | P0 |
| C4 | Optional fields: name, unit (chai, gói, lốc, thùng), cost price, barcode (scanned), category. | P1 |
| C5 | Multiple units per product (e.g. 1 chai 10.000đ, 1 lốc 6 chai 55.000đ). | P1 |
| C6 | Price list view: grid of photos with large price labels; searchable by name if present. | P0 |
| C7 | Export/print price list (PDF / image). | P2 |

### 5.2 Checkout (Bán hàng)

| ID | Requirement | Priority |
|---|---|---|
| S1 | Camera mode: point at one item, tap shutter; app shows top match (photo, name, price) and up to 3 alternatives. Tap to confirm adds to cart. | P0 |
| S2 | Barcode: if a barcode is detected in frame and linked to a product, use it as the match. | P1 |
| S3 | Grid mode: tap product photos to add to cart. | P0 |
| S4 | Unknown item: "Not found" offers (a) enter price manually for this sale (b) enroll now (lead role or allowed helpers). Manual-price sales are flagged for the lead to review. | P0 |
| S5 | Cart: each line shows thumbnail, price, quantity with large ± buttons; swipe/tap to remove. Running total always visible in very large digits. | P0 |
| S6 | Pay screen: total in very large digits; buttons "Tiền mặt" (cash) and "Chuyển khoản" (transfer). Cash: optional amount received, shows change. Transfer: VietQR with amount and order memo. | P0 |
| S7 | Read total aloud in Vietnamese (TTS) — for elders and for the customer. | P1 |
| S8 | Multi-item photo detection: one photo, all items become editable cart lines (phase 1: server-side SAM + embedding match; phase 2: fine-tuned YOLO). | P0 |
| S9 | Automatic transfer confirmation via bank notification integration. | P2 |
| S10 | Void/refund a completed sale, with reason; logged. | P1 |

### 5.3 Expenses and purchases (Chi / Nhập hàng)

| ID | Requirement | Priority |
|---|---|---|
| E1 | Add expense: amount, category (nhập hàng, điện, nước, khác), optional photo of supplier bill, optional note. | P0 |
| E2 | Purchase linked to products: quantity and unit cost per product; updates product cost price. | P1 |
| E3 | When cost price rises so margin < configured threshold (default 0) the app alerts the lead and suggests a new price. | P1 |
| E4 | Stock quantity tracking (purchases add, sales subtract). | P2 |

### 5.4 Reports (Báo cáo)

| ID | Requirement | Priority |
|---|---|---|
| R1 | Today screen: revenue, number of sales, cash vs transfer split, expenses, net. | P0 |
| R2 | End-of-day close (chốt sổ): enter counted cash; app shows expected cash and difference. | P0 |
| R3 | Day/week/month views with simple bar chart of revenue and expenses. | P1 |
| R4 | Top products by revenue and by quantity; gross margin where cost is known. | P1 |
| R5 | Export sales/expenses to CSV/Excel for tax declaration. | P1 |

### 5.5 Family accounts and roles

| ID | Requirement | Priority |
|---|---|---|
| U1 | One store, multiple family devices/users. Join by scanning a store QR from the lead's phone. | P0 |
| U2 | Roles: **Lead** (all permissions, sets prices), **Seller** (checkout, view prices, add manual-price sale), configurable "can enroll products". | P0 |
| U3 | Each sale records which user made it. | P0 |
| U4 | Simple per-user PIN, optional. | P1 |

### 5.6 Settings

| ID | Requirement | Priority |
|---|---|---|
| T1 | Bank account for VietQR (bank, account number, account name); verified by showing a test QR. | P0 |
| T2 | Font scale (default large), elder mode (grid-only, larger buttons, TTS on). | P0 |
| T3 | Language: Vietnamese default; English optional. | P1 |

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| Usability | Vietnamese UI; minimum 18sp body text, 32sp+ for prices and totals; tap targets ≥56dp; max 3 taps from home to payment QR; no jargon. |
| Offline | Recognition runs on the server and needs internet. Without internet, grid mode, manual price, catalog, and VietQR generation still work; sales sync when online. |
| Performance | Counter photo to editable cart ≤3 s end to end on 4G/Wi-Fi; app cold start ≤3 s. |
| Accuracy | Recognition never adds to cart without seller confirmation. Track confirmed-vs-corrected rate as the accuracy metric. |
| Data safety | Local database + cloud backup; restore onto a new phone; no data loss if phone is lost after last sync. |
| Privacy | Store data belongs to the store; no selling or sharing; photos are of products, not customers. Comply with Decree 13/2023/ND-CP on personal data for user accounts. |
| Cost | Server GPU cost per scan must be measured in phase 1 and fit the phase 3 pricing model. |
| Platform | Phase 1–2: Android build for the family store. Phase 3: Google Play and App Store. |

## 7. Key user flows

**F1 — First setup (lead, ~10 min + enrollment):** install, enter store name, enter bank account, see test VietQR, start enrolling: photo, price, next. Invite family by QR.

**F2 — Helper checkout:** Open app (lands on camera). Point at item, tap. Big card shows *Sting đỏ — 10.000đ*, tap ✓. Repeat. Tap total. Customer scans QR or pays cash. Tap "Đã nhận" (received). Done; sale logged.

**F3 — Unknown item:** "Không tìm thấy". Helper enters price told by customer/label, sale goes through, flagged. Lead later sees "3 items sold without catalog" and enrolls them in one tap from the flagged photo.

**F4 — Price increase:** Lead records purchase of Coca thùng at new cost. App: "Coca 330ml: cost 8.500đ, selling 9.000đ, margin 5%. Raise to 10.000đ?" Lead accepts; all devices update.

**F5 — End of day:** Lead opens Today, counts cash box, enters amount. App: expected cash 1.240.000đ, counted 1.230.000đ, difference −10.000đ.

## 8. Success metrics

| Metric | Target (family store, after 4 weeks) |
|---|---|
| "Ask mom for price" events (self-reported per day) | From many per shift to ~0 |
| Share of sales recorded in app | ≥95% |
| End-of-day cash discrepancy | <2% of daily revenue |
| Median checkout time, 5 items | ≤30 s |
| Recognition confirmed without correction | ≥90% |
| Days active per week (any user) | ≥6 |

Market metrics (pilot of 10 stores): week-4 retention ≥60%; ≥2 stores willing to pay.

## 9. Technical direction (non-binding)

- **Client:** cross-platform mobile app (Flutter or React Native) so phase 3 ships to both stores; camera capture and upload, no on-device ML.
- **Recognition server, phase 1:** pretrained SAM-family model segments the photo into item crops; pretrained image-embedding model (DINOv2/CLIP-class) embeds each crop; cosine similarity over a per-store vector index; several embeddings per product; threshold + top-k UI. No training.
- **Recognition server, phase 2:** YOLO detection model fine-tuned on phase 1 labeled photos (enrollment photos + seller-confirmed checkout lines). Retrain periodically; embedding match covers products newer than the last model.
- **Data collection (phase 1):** store every checkout photo with its confirmed cart lines and corrections. This dataset is the input for phase 2.
- **Barcode:** ML Kit / ZXing on-device.
- **Payments:** VietQR (EMVCo-based NAPAS standard) generated locally from account + amount + memo.
- **Data:** local SQLite as source of truth; sync to a cloud backend (e.g. Postgres/Firebase/Supabase) for multi-device and backup; conflict rule: lead's price edits win, sales are append-only.
- **TTS:** Android Vietnamese TTS.

Verify current library and API documentation before implementation.

## 10. Release plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **1 — Family MVP (zero training)** | All P0 requirements in the family store. Capture a photo, a pretrained SAM model on the server segments the items, a pretrained embedding model matches each crop to the catalog. No training or fine-tuning. Every enrollment and confirmed checkout photo is stored as labeled data. | A1–A4 pass; 4 weeks of daily use; metrics in §8 trending to target |
| **2 — Fine-tuned YOLO (target recognition)** | Fine-tune a YOLO detection model on the labeled photos collected in phase 1. YOLO replaces SAM + embedding matching as the main recognizer; embedding matching stays as a fallback for products added after the last training run. P1 requirements. | Fine-tuned YOLO beats the phase 1 pipeline on a held-out set of real counter photos (accuracy and latency) |
| **3 — Market launch** | Publish on Google Play and the App Store. Onboarding for other stores, pricing model. | Store review approved; A5 pass |

## 11. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Look-alike products cause wrong charges | High | High | Visual confirmation; alternatives; multiple reference photos; barcode when available |
| Lead does not finish enrollment | Medium | High | Enroll-while-selling (F3), batch enrollment mode, start with top 30 sellers |
| Elders cannot use camera mode | Medium | Medium | Grid mode, elder mode, TTS |
| Weak internet or server downtime blocks recognition | Medium | Medium | Grid mode and manual price work offline; image compression before upload |
| SAM crops noise (hands, bags, background) | High | Medium | Filter crops by size and match score; seller removes stray lines; phase 2 YOLO |
| Server GPU cost too high per store | Medium | Medium | Measure in phase 1; batch, downscale images; smaller SAM variant |
| Tax rules change scope | Medium | Medium | Keep export flexible; review regulations before phase 3 |
| Competitors add photo enrollment | Low–Medium | Medium | Focus on family/elder UX and zero setup, not feature count |
| Data loss on phone loss | Low | High | Automatic cloud backup |

## 12. Open questions

1. Payment confirmation: which bank does the family use, and does it offer a notification API or a supported third-party integration?
2. Do we need receipts for customers at all, or only on request (digital/share image)?
3. How should loose/weighted goods (rice, sugar by kg) be priced: per unit price × quantity entered?
4. Business model: free for one store with paid backup/multi-device, or one-time fee?
5. Should helpers be allowed to enroll products, or only to flag unknown items?
6. Exact tax obligations by revenue tier for 2026 and what record format the tax office accepts.

## 13. Glossary

- **Tạp hóa:** small neighborhood convenience/grocery store.
- **Hộ kinh doanh:** household business, the legal form of most tạp hóa.
- **Thuế khoán:** presumptive lump-sum tax, being phased out.
- **VietQR:** NAPAS interbank QR standard; any Vietnamese banking app can pay it.
- **Enrollment:** adding a product to the catalog by photo + price.
- **Lead:** the family member who owns prices (role in app).
- **Chốt sổ:** end-of-day close and cash reconciliation.
