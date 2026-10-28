# Stock and import receipts: scan a supplier receipt into stock and expenses

Status: Proposed · Date: 2026-10-25 · Scope: camera screen, catalog, expenses, stock,
recognition (PRD E2, E4 promoted from P2)

## Goal

Most photos the family takes are products at checkout. A few times a month the Lead also
photographs a supplier's import receipt (hóa đơn nhập hàng). The app notices the photo is a
document, offers a document button, reads the receipt with a pretrained OCR model, parses
each line into `{product_name, quantity, cost}`, maps every line to an existing catalog
product with a decision model, and on confirm records one expense with purchase lines and
adds the quantities to stock. The app keeps a receipt history and warns when a product may
run out, using a configurable threshold.

## Definition of done

| #   | Criterion                                                                                                                                                                    | Proof                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| D1  | Stock view lists tracked products with quantity and status (`ok`, `low`, `out`); product detail shows the stock quantity, its threshold and recent movements.                | Jest `StockScreen.test.tsx`, `ProductScreen.test.tsx`; `tests/stock.rs`                              |
| D2  | Sales subtract stock, voids add it back, confirmed receipts add it, Lead adjustments set it. Every change writes one `stock_movements` row in the same transaction.          | `tests/stock.rs`: sale, void, receipt, adjustment, untracked product stays `NULL`                    |
| D3  | A checkout scan of a receipt photo returns `document.detected = true`; the camera shows a document icon button at the bottom right of the captured image frame.              | `tests/recognition.rs` with fake detector; model test on fixture receipts; Jest `CameraScreen`       |
| D4  | Tapping the button runs OCR + parse + product mapping and opens the review screen in under 6 s (p95 of 5 runs, Railway `test`, image already uploaded by the scan).          | `packages/e2e/tests/receipts.test.ts`; numbers appended to `recognition-latency.md`                  |
| D5  | Parser returns `{product_name, quantity, cost}` per item line on the mock fixtures; each line maps to the right catalog product or to `none`.                                | Unit tests on `receipt::parse`; `tests/receipts.rs` with fake OCR + fake decisions                   |
| D6  | Confirm creates one `nhap_hang` expense with purchase lines, adds stock, marks the receipt `confirmed`; replay with the same `Idempotency-Key` returns the same receipt.     | `tests/receipts.rs`                                                                                  |
| D7  | Receipt history: list and detail of past receipts (date, total, lines, mapped products, photo).                                                                              | `tests/receipts.rs`; Jest `ReceiptHistory.test.tsx`                                                  |
| D8  | When a product's stock falls to or below its threshold, the server emits `stock.low`; the app shows a banner and a dashboard "Sắp hết hàng" list. Threshold is configurable. | `tests/stock.rs` (event once per crossing); Jest `AlertsSection.test.tsx`, `LowStockBanner.test.tsx` |

## Decisions

- **Stock lives on the product row, history in a ledger.** `products.stock_quantity INT NULL`.
  `NULL` means untracked: the product never got a receipt or a count. Sales of untracked
  products do not create a quantity, so a shop that never scans receipts sees no false
  "out of stock". Tracked stock may go negative (sold before the receipt was scanned); the
  UI shows it as `out`. Each change writes `stock_movements` with `quantity_after`.
- **Threshold.** Store default `stores.low_stock_threshold INT NOT NULL DEFAULT 5`;
  per-product override `products.low_stock_threshold INT NULL`. Status: `out` when
  quantity ≤ 0, `low` when quantity ≤ threshold, else `ok`; `untracked` when `NULL`.
- **`stock.low` fires on the crossing only**: when a movement moves the quantity from
  above the threshold to at or below it. Restocking above the threshold re-arms it. No
  extra table: the ledger row's `quantity_after` and the previous quantity decide it.
- **OCR models: PP-OCRv6 det small + VietOCR `vgg_seq2seq`, both pretrained ONNX on the
  existing `ort` runtime.** Source: release `ocr-v1` of `duchoa1297/vietocr-onnx`
  (Apache-2.0; VietOCR by pbcquoc was trained on Vietnamese printed text and is the
  common recognizer for Vietnamese receipts, e.g. MC-OCR 2021). Files: `det.onnx` (9.9 MB),
  `vietocr_encoder.onnx` (84 MB), `vietocr_decoder.onnx` (5.1 MB), `vietocr.json`
  (vocab, offsets, widths). `fetch-models.sh` downloads them with pinned SHA-256 hashes;
  the build fails on a mismatch. Tesseract `vie` was rejected: weaker on diacritics and
  receipt fonts, and an extra system binary. PP-OCRv5 recognition was rejected: no
  Vietnamese in its published language set. No PyTorch at runtime.
- **Detection (`TextDetector` port).** DB post-processing in Rust: probability map, threshold
  0.3, connected components to axis-aligned boxes, box score ≥ 0.5, unclip ratio 2.0
  (keeps diacritics inside the box), boxes sorted top-to-bottom, left-to-right, then grouped
  into lines by vertical overlap. Input: longest side 960 px, padded to a multiple of 32,
  ImageNet mean/std.
- **Recognition (`ReceiptOcr` port).** Each line crop: height 32 px, width
  `ceil(32·w/h / 10)·10` clamped to `vietocr.json` bounds, RGB / 255, no mean/std. Lines are
  batched by equal width; encoder once per batch, greedy decoder loop from `sos` until
  `eos` or `max_seq_length`. One shared `ort` session per model, `intra_threads` from env.
  Budget ≤ 2.5 s for a 40-line receipt on 4 vCPU. A fake OCR for tests returns fixture text.
- **Document detection runs inside the existing scan.** The same detector runs on the
  downsized scan image in parallel with SAM proposals (~150 ms on 4 vCPU).
  `detected = text_lines >= 6 && text_area_ratio >= 0.08`. The scan response gains
  `document: { detected, score, text_lines, line_boxes }`. No extra round trip; the checkout path is
  unchanged when no document is present.
- **Live receipt detection.** Expo Go has no frame processors, so the live camera sends
  a small JPEG/PNG still every 2–3 seconds to `POST /v1/recognition/document-probes`.
  This detector-only endpoint returns `DocumentSignal` with normalized boxes per grouped
  text line for the preview overlay. It runs no SAM or embeddings and persists no scan,
  image row or object. The image limit is 512 KB; the member limit is 40 requests/minute.
  An instance without a text detector returns 503 `ocr_unavailable`.
- **Parse: rules first, decision model second.** `receipt::parse` turns OCR lines into
  candidates with regexes for Vietnamese money (`204.000`, `204,000`, `204000đ`) and
  quantities (`x24`, `SL 24`, `24 thùng`). Common layouts: `name qty unit_price amount`,
  `name xqty amount`, `qty name amount`. `cost` is the line amount (thành tiền) in đồng; when
  only the unit price is present, `cost = quantity × unit_price`. Then one decision request
  answers two `choice` questions per candidate line:
  - `role_<i>`: `item` | `total` | `header` | `other`;
  - `match_<i>`: one of up to 8 catalog products (prefiltered by the existing
    `unaccent` + `pg_trgm` index) or `none`.
    Lines with role `item` are kept. A match is accepted when its probability ≥ 0.5 and is
    not `none`; otherwise the line stays unmatched and shows its candidates.
- **Decision model is configurable; Mercury now, Jev later.** OpenRouter Decisions API
  (`POST https://openrouter.ai/api/alpha/decisions`). Env: `DECISIONS_MODEL` (default
  `inception/mercury-decide:free`; switch to `~typesafe/jev-latest` by env only),
  `OPENROUTER_API_KEY`, `DECISIONS_URL`, `DECISIONS_TIMEOUT_MS` (default 2500). On timeout,
  HTTP error or missing key the parser falls back to rules: keyword roles (`tổng`, `cộng`,
  `thanh toán`, `chiết khấu` are not items) and the top trigram candidate when similarity
  ≥ 0.6. The receipt records `parser: "decisions" | "fallback"` and the model id.
- **Mock data schema now.** Line schema is exactly `{product_name, quantity, cost}` plus
  match fields. Units (`product_units`) are out of scope: quantities are in the product's
  base unit. Fixture receipts (rendered PNGs with Vietnamese text + expected JSON) live in
  `apps/backend/crates/api/tests/fixtures/receipts/`; `taphoa-seed` adds two confirmed
  receipts and starting stock for seeded products.
- **Synchronous receipt parse.** `POST /v1/receipts` returns the parsed draft in the same
  request (≤ 6 s budget). Receipts are rare, so no job queue.
- **Confirm writes everything in one transaction**: expense (`category='nhap_hang'`,
  `amount = Σ cost`, `image_id` = receipt photo), purchase lines (`unit_cost = round_up(cost /
quantity)`), stock movements (`reason='receipt'`), existing margin-alert logic, events.
  Unmatched lines must be mapped or dropped by the user before confirm (422 otherwise).
- **Notifications are in-app.** SSE `stock.low` shows a banner on any shop screen and the
  dashboard lists low products. A local OS notification is optional (only if Expo Go
  supports it without a dev build); no push server.

## API contract (source of truth: `docs/api/openapi.yaml`, `docs/api/asyncapi.yaml`)

Stock:

- `GET /v1/stock?status=all|low|out&cursor&limit` → `{ items: StockItem[], next_cursor }`.
  `StockItem { product_id, name, image_url, stock_quantity, low_stock_threshold
(effective), status: ok|low|out|untracked, updated_at }`. Sorted `out`, `low`, then name.
  `all` excludes `untracked`.
- `Product` gains `stock_quantity: integer | null`, `low_stock_threshold: integer | null`
  (override), `stock_status`. `ProductPatch` accepts `low_stock_threshold` (Lead).
- `POST /v1/products/{id}/stock-adjustments` (Lead, `Idempotency-Key`):
  `{ count: int >= 0 }` sets the quantity, or `{ delta: int != 0 }` changes it; optional
  `note`. Exactly one of `count`/`delta` (422). 200 returns `StockMovement`.
- `GET /v1/products/{id}/stock-movements?cursor&limit` → `StockMovement { id, delta,
quantity_after, reason: receipt|sale|sale_void|adjustment, ref_id, member_id, note,
created_at }`, newest first.
- `Store` / `StorePatch` gain `low_stock_threshold: integer 0..100000` (Lead).

Recognition:

- `ScanResult` gains `document: DocumentSignal { detected: boolean, score: number,
text_lines: integer, line_boxes: [number, number, number, number][] }`.
  `score` = clamped `text_area_ratio / 0.2`. Present on every scan and stored scan read.
  `line_boxes` are grouped lines ordered top-to-bottom, each normalized `[x, y, w, h]`
  clamped to the image bounds, capped at 40. Empty when no text is found; `text_lines`
  retains the full count. Old stored signals without boxes read as `line_boxes: []`.
- `POST /v1/recognition/document-probes` (same auth/roles as checkout scans), multipart
  `image` (JPEG/PNG, ≤ 512 KB) → 200 `DocumentSignal`. Detector only, no persistence.
  413 oversized image, 415 unsupported format, 422 invalid image, 429 member limit
  (40/minute, `Retry-After`), 503 `ocr_unavailable` without a detector or `unavailable` when
  inference admission is occupied.

Receipts (Lead or `can_enroll`):

- `POST /v1/receipts` `{ image_id }` (`Idempotency-Key`) → 201 `Receipt` with
  `status='draft'`. 404 unknown image, 422 `no_text` when OCR finds nothing,
  503 `ocr_unavailable` when the OCR models are absent (model-free image).
- `GET /v1/receipts?status&cursor&limit` → `{ items: ReceiptSummary[], next_cursor }`,
  newest first. `ReceiptSummary { id, status, total, line_count, matched_count, image_url,
created_at, confirmed_at, expense_id }`.
- `GET /v1/receipts/{id}` → `Receipt`.
- `POST /v1/receipts/{id}/confirm` (`Idempotency-Key`)
  `{ lines: [{ line_id?, product_id, quantity > 0, cost >= 0 }] (1..100), paid_with:
cash_box|other, spent_at? }` → 200 `Receipt` (`status='confirmed'`, `expense_id`).
  409 `already_confirmed`, 422 unknown product or empty lines.
- `DELETE /v1/receipts/{id}` → 204, discards a draft (409 when confirmed).

```json
// Receipt
{
  "id": "uuid",
  "status": "draft",
  "image_id": "uuid",
  "image_url": "https://...",
  "total": 456000,
  "parser": "decisions",
  "model": "inception/mercury-decide:free",
  "lines": [
    {
      "id": "uuid",
      "position": 0,
      "raw_text": "Coca lon 330ml x24 204.000",
      "product_name": "Coca lon 330ml",
      "quantity": 24,
      "cost": 204000,
      "product_id": "uuid",
      "match_confidence": 0.91,
      "candidates": [
        { "product_id": "uuid", "name": "Coca-Cola lon", "probability": 0.91 }
      ]
    }
  ],
  "timings": { "ocr": 1840, "parse": 12, "decisions": 620, "total": 2610 },
  "expense_id": null,
  "created_at": "...",
  "confirmed_at": null
}
```

Events (AsyncAPI, via outbox): `stock.changed { product_id, stock_quantity, reason }`,
`stock.low { product_id, name, stock_quantity, threshold }`,
`receipt.confirmed { receipt_id, expense_id, total, line_count }`.

## Data model (migration `0601_stock_receipts.sql`)

```sql
ALTER TABLE stores ADD COLUMN low_stock_threshold INT NOT NULL DEFAULT 5
    CHECK (low_stock_threshold BETWEEN 0 AND 100000);
ALTER TABLE products
    ADD COLUMN stock_quantity INT,
    ADD COLUMN low_stock_threshold INT CHECK (low_stock_threshold BETWEEN 0 AND 100000);

CREATE TABLE stock_movements (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id       UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    product_id     UUID NOT NULL REFERENCES products ON DELETE CASCADE,
    delta          INT NOT NULL,
    quantity_after INT NOT NULL,
    reason         TEXT NOT NULL CHECK (reason IN ('receipt', 'sale', 'sale_void', 'adjustment')),
    ref_id         UUID,
    member_id      UUID REFERENCES members,
    note           TEXT CHECK (char_length(note) <= 200),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product ON stock_movements (store_id, product_id, created_at DESC);

CREATE TABLE receipts (
    id           UUID PRIMARY KEY,
    store_id     UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    member_id    UUID NOT NULL REFERENCES members,
    image_id     UUID NOT NULL REFERENCES images,
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'discarded')),
    ocr_text     TEXT NOT NULL,
    parser       TEXT NOT NULL CHECK (parser IN ('decisions', 'fallback')),
    model        TEXT,
    timings      JSONB NOT NULL DEFAULT '{}',
    total        BIGINT NOT NULL DEFAULT 0,
    expense_id   UUID REFERENCES expenses ON DELETE SET NULL,
    request_hash BYTEA NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX receipts_store_created ON receipts (store_id, created_at DESC);

CREATE TABLE receipt_lines (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id       UUID NOT NULL REFERENCES receipts ON DELETE CASCADE,
    store_id         UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    position         INT NOT NULL,
    raw_text         TEXT NOT NULL,
    product_name     TEXT NOT NULL,
    quantity         INT NOT NULL CHECK (quantity > 0),
    cost             BIGINT NOT NULL CHECK (cost >= 0),
    product_id       UUID REFERENCES products ON DELETE SET NULL,
    match_confidence REAL,
    candidates       JSONB NOT NULL DEFAULT '[]',
    UNIQUE (receipt_id, position)
);
```

Images: purpose `expense_receipt` already exists; receipt photos keep the scan's image row.

## Mobile flow

```
camera shutter -> scan result (existing)
  document.detected -> DocumentButton (doc icon, bottom right of the captured image frame)
  tap -> POST /v1/receipts { image_id } -> "Đang đọc hóa đơn…" overlay (< 6 s)
      -> /receipt/[id] review: lines (name, qty, cost, mapped product chip)
           amber chip = unmatched -> product picker | drop line
           total, paid_with toggle, Confirm
      -> POST /v1/receipts/{id}/confirm -> toast "Đã nhập kho N sản phẩm" -> back to camera
Kho tab -> header segment "Sản phẩm | Tồn kho" -> /stock list (out, low, ok), filter "Sắp hết"
product/[id] -> stock stat (qty, threshold, status), "Kiểm kho" adjust sheet, movements list
Expense screen + dashboard -> "Hóa đơn nhập" -> /receipts history -> /receipt/[id] read-only
SSE stock.low -> LowStockBanner on shop screens; dashboard AlertsSection "Sắp hết hàng"
Account (Lead) -> "Ngưỡng sắp hết" stepper (store); product screen -> per-product override
```

## Task graph (TDD: each task lands failing tests first, then code; T0 merges before dependents)

```
T0 contract ─┬─ B1 migration + seed ─┬─ B2 stock module ──────────┐
             │                       │                            ├─ B5 receipts API ─┬─ E1 deploy + latency e2e
             ├─ B3 parser + decisions client (pure) ──────────────┤                   │
             ├─ B4 OCR + text detector adapters ─┬────────────────┘                   │
             │                                   └─ B6 scan document flag             │
             └─ M0 api-client hooks + mock ─┬─ M1 stock view + product stock + settings
                                            ├─ M2 document button + receipt review + history
                                            └─ M3 low-stock banner + dashboard ────────┴─ E2 web e2e flow
```

| ID  | Task                                                                                                                                                                                                                                  | Depends   | Tests first (acceptance)                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0  | OpenAPI + AsyncAPI changes above, data-model.md §3.6b, CONTEXT.md terms, regenerate `packages/api-client/src/schema.d.ts`                                                                                                             | none      | `tests/contract.rs`, `tests/asyncapi.rs`, api-client tests pass                                                                                                                                                |
| B1  | Migration `0601_stock_receipts.sql`; `taphoa-seed` starting stock + 2 confirmed receipts; fixture receipts (PNG + expected JSON)                                                                                                      | T0        | `tests/migrations.rs`: tables/columns/checks exist; `tests/seed_invariants.rs`: seeded stock equals movements sum                                                                                              |
| B2  | `stock` module: `stock::apply(tx, ...)`, sale create/void hooks, adjustments, `GET /v1/stock`, movements, product + store fields, `stock.changed`/`stock.low`                                                                         | B1        | `tests/stock.rs`: every reason, untracked stays `NULL`, low fires once per crossing, permissions, contract                                                                                                     |
| B3  | `receipt` parse (regex), `decisions` client (`DecisionClient` trait, OpenRouter adapter, fake), fallback, candidate prefilter query                                                                                                   | T0        | unit: money/qty formats, layouts, role/match mapping, timeout fallback (wiremock), model from env                                                                                                              |
| B4  | `TextDetector` (PP-OCRv6 det, DB post-process) + `ReceiptOcr` (VietOCR encoder/decoder) ONNX adapters in `taphoa-recognition`; `fetch-models.sh` with SHA-256 pins; Dockerfile env paths; `.railway/railway.ts` + `.env.example` vars | T0        | unit: preprocessing widths, DB boxes on a synthetic map, line grouping, greedy decode with a fake session; model tests (ignored without weights): fixtures detected, OCR text contains expected names, < 2.5 s |
| B5  | Receipts API: create (OCR + parse + decisions + persist + timings), list, get, confirm (expense, purchase lines, stock, margin alerts, events), discard                                                                               | B1-B4     | `tests/receipts.rs` with fakes: 201 shape, 404/422/503, confirm, idempotency replay, 409, history ordering                                                                                                     |
| B6  | Scan pipeline runs `TextDetector` in parallel with proposals; `document` field                                                                                                                                                        | B4        | `tests/recognition.rs`: fake detector true/false; scan p95 unchanged                                                                                                                                           |
| M0  | api-client wrappers + hooks: `useStock`, `useStockMovements`, `useAdjustStock`, `useCreateReceipt`, `useReceipts`, `useReceipt`, `useConfirmReceipt`, `useDiscardReceipt`; mock routes                                                | T0        | hook tests against the mock                                                                                                                                                                                    |
| M1  | Stock view + Kho segment, `StockBadge`, product screen stock stat + adjust sheet + movements, Account threshold stepper, product override                                                                                             | M0        | `StockScreen.test.tsx`, `ProductScreen.test.tsx`, `AccountScreen` threshold test                                                                                                                               |
| M2  | `DocumentButton` on the captured frame, receipt create overlay, `/receipt/[id]` review + confirm, `/receipts` history, entry points                                                                                                   | M0        | `CameraScreen.test.tsx` (button shown only when detected), `ReceiptReview.test.tsx`, `ReceiptHistory.test.tsx`                                                                                                 |
| M3  | `LowStockBanner` from SSE `stock.low`, dashboard "Sắp hết hàng" section                                                                                                                                                               | M0        | `LowStockBanner.test.tsx`, `AlertsSection.test.tsx`                                                                                                                                                            |
| E1  | Deploy backend to Railway `test` with OCR + key; `packages/e2e/tests/receipts.test.ts` (create < 6 s p95 of 5, confirm adds stock); then production                                                                                   | B5, B6    | e2e passes against `test`                                                                                                                                                                                      |
| E2  | Playwright `e2e-web/receipts.spec.ts`: scan fixture receipt, review, confirm, stock view shows the quantities                                                                                                                         | B5, M1-M3 | spec passes in CI                                                                                                                                                                                              |

## Out of scope

Product units on receipts, supplier entities, creating new products from receipt lines,
VAT/e-invoice (XML) import, on-device OCR, push notifications, automatic reorder, stock
counts per location, training or fine-tuning OCR/decision models.
