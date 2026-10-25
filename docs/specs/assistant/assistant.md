# Assistant: use cases, tools, API and UI

Status: Accepted · Date: 2026-10-25 · Program: [README](README.md) · ADR
[0005](../../adr/0005-assistant-in-backend.md)

## Use cases

Every use case has golden cases ([golden-set.md](golden-set.md)). "Lead" means the tool
requires a Lead-only `auth::Action`; sellers get a polite refusal, never the data.

| ID  | Use case                      | What the owner gets                                                                                                                          | Tools                                                                              | Who              |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------- |
| U1  | Restock plan                  | Products to import now with quantities from stock, threshold and 14-day sales speed, grouped by last supplier, with last cost and total cost | `get_restock_plan`, `propose_reorder_list`                                         | all; cost Lead   |
| U2  | Daily / weekly summary        | Revenue, sale count, gross profit, top products, change versus the previous period                                                           | `get_sales_summary`, `get_top_products`                                            | all; profit Lead |
| U3  | Margin check                  | Products with thin or negative margin (latest receipt cost versus retail price) and a suggested price                                        | `get_margin_report`, `propose_price_change`                                        | Lead             |
| U4  | Dead stock                    | Tracked products with stock but no sales in N days, with tied-up money                                                                       | `get_dead_stock`                                                                   | all; money Lead  |
| U5  | Day-close helper              | Explanation of a cash difference: cash sales, cash repayments, cash expenses, voids, expected versus counted                                 | `explain_day_close`                                                                | Lead             |
| U6  | Review queue triage           | For each manual line, the likely catalog product and why                                                                                     | `list_review_queue`, `suggest_manual_line_matches`                                 | Lead             |
| U7  | Recognition health            | Products often missed or confused at checkout and which need more reference photos                                                           | `get_recognition_health`                                                           | Lead             |
| U8  | Seller activity               | Sales, voids and manual lines per member                                                                                                     | `get_member_activity`                                                              | Lead             |
| U9  | Anomalies                     | Unusual voids, negative stock, sudden price changes, sales outside opening hours                                                             | `detect_anomalies`                                                                 | Lead             |
| U10 | Tax helper                    | Revenue per period against the current hộ kinh doanh thresholds, what to declare, how to export; cites the rule version                      | `get_tax_overview`, `start_export`                                                 | Lead             |
| U11 | Draft actions                 | Stock adjustment, expense, price change, threshold change drafted as proposed actions                                                        | `propose_*`                                                                        | by action        |
| U12 | App how-to                    | Answers from the in-repo Vietnamese help articles, with the screen to open                                                                   | `search_help`                                                                      | all              |
| U13 | Daily digest                  | Morning summary card + push: yesterday's numbers, restock, overdue debts, open drafts                                                        | digest job (X8) reuses U1, U2, U23 tools                                           | all              |
| U14 | Receipt in chat               | A detected receipt is walked through line by line in chat, fixed by text or voice, confirmed with one card                                   | `get_receipt`, `propose_receipt_line_update`, `propose_receipt_confirm`            | can_enroll       |
| U15 | Voice input                   | Hold-to-talk dictation into the chat input (`vi-VN`, on device)                                                                              | none (client)                                                                      | all              |
| U16 | Natural-language lookup       | "Hôm qua bán mấy chai Coca?", "tuần này chi bao nhiêu tiền điện?"                                                                            | `search_sales`, `search_products`, `list_expenses`                                 | all              |
| U17 | Supplier price comparison     | Cost of a product across suppliers and dates from receipt history; cheapest recent supplier                                                  | `get_supplier_prices`                                                              | Lead             |
| U18 | Demand forecast, holiday prep | Expected units for the next 7 days per product (weekday pattern, recent trend, Tết and holiday uplift table)                                 | `forecast_demand`                                                                  | all              |
| U19 | Catalog cleanup               | Possible duplicates, missing category, price or photos, products with fewer than 3 references                                                | `get_catalog_issues`                                                               | all              |
| U20 | Threshold tuning              | Suggested low-stock threshold per product from sales speed and restock gap                                                                   | `suggest_low_stock_thresholds`, `propose_threshold_update`                         | Lead             |
| U21 | Store setup helper            | Checklist: VietQR bank account, members invited, permissions, thresholds, first day close                                                    | `get_setup_checklist`, `propose_invite`                                            | Lead             |
| U22 | Export helper                 | Transaction CSV for a period or price list, returned as a download link                                                                      | `start_export`                                                                     | Lead             |
| U23 | Debt book                     | Who owes what, overdue debts, reminder text, record a credit sale adjustment or repayment                                                    | `get_debts`, `draft_debt_reminder`, `propose_repayment`, `propose_debt_adjustment` | all; adjust Lead |

Expiry tracking is out of scope.

## Tool catalog

Tools live in `apps/backend/crates/api/src/assistant/tools/`. Each tool has a name, a
Vietnamese description for the model, a JSON Schema for arguments, the required
`auth::Action` (or none), and an output JSON shape. Tool output is data: it is wrapped in a
`tool` message and never treated as instructions.

| Tool                           | Kind    | Arguments                                                    | Requires                                         |
| ------------------------------ | ------- | ------------------------------------------------------------ | ------------------------------------------------ |
| `get_store_overview`           | read    | none                                                         | none                                             |
| `get_sales_summary`            | read    | `from`, `to`, `group_by` (day, week, member)                 | none; profit fields need `ChangePrice`           |
| `get_top_products`             | read    | `from`, `to`, `metric` (units, revenue), `limit`             | none                                             |
| `search_sales`                 | read    | `from`, `to`, `product_query?`, `member?`                    | none                                             |
| `search_products`              | read    | `query`, `limit`                                             | none                                             |
| `get_stock_levels`             | read    | `filter` (low, negative, untracked, all)                     | none                                             |
| `get_restock_plan`             | read    | `horizon_days` (default 7)                                   | none; cost fields need `ChangePrice`             |
| `get_margin_report`            | read    | `min_margin_pct` (default 10)                                | `ChangePrice`                                    |
| `get_dead_stock`               | read    | `days` (default 30)                                          | none                                             |
| `explain_day_close`            | read    | `business_date`                                              | `DayClose`                                       |
| `list_review_queue`            | read    | `limit`                                                      | `ReviewQueue`                                    |
| `suggest_manual_line_matches`  | read    | `manual_line_ids`                                            | `ReviewQueue`                                    |
| `get_recognition_health`       | read    | `from`, `to`                                                 | `RecognitionReport`                              |
| `get_member_activity`          | read    | `from`, `to`                                                 | `ManageMembers`                                  |
| `detect_anomalies`             | read    | `from`, `to`                                                 | `ViewAlerts`                                     |
| `get_tax_overview`             | read    | `year`, `period` (month, quarter)                            | `Exports`                                        |
| `list_expenses`                | read    | `from`, `to`, `category?`                                    | `AddExpense`                                     |
| `get_supplier_prices`          | read    | `product_query`                                              | `ChangePrice`                                    |
| `forecast_demand`              | read    | `days` (1..14), `product_query?`                             | none                                             |
| `get_catalog_issues`           | read    | none                                                         | none                                             |
| `suggest_low_stock_thresholds` | read    | none                                                         | `AdjustStock`                                    |
| `get_setup_checklist`          | read    | none                                                         | `ManageStore`                                    |
| `search_help`                  | read    | `query`                                                      | none                                             |
| `start_export`                 | read    | `kind` (transactions, price_list), `from`, `to`              | `Exports`                                        |
| `get_receipt`                  | read    | `receipt_id`                                                 | `EnrollProduct`                                  |
| `get_debts`                    | read    | `customer_query?`, `overdue_days?`                           | `RecordDebt`                                     |
| `draft_debt_reminder`          | read    | `customer_id`                                                | `RecordDebt`                                     |
| `propose_stock_adjustment`     | propose | `product_id`, `delta`, `reason`                              | `AdjustStock`                                    |
| `propose_expense`              | propose | `amount`, `category`, `note`, `paid_with`                    | `AddExpense`                                     |
| `propose_price_change`         | propose | `product_id`, `new_price`                                    | `ChangePrice`                                    |
| `propose_threshold_update`     | propose | `product_id`, `threshold`                                    | `AdjustStock`                                    |
| `propose_reorder_list`         | propose | `items[{product_id, quantity}]`, `supplier?`                 | none (creates a shareable list; no stock change) |
| `propose_receipt_line_update`  | propose | `receipt_id`, `line_id`, `product_id?`, `quantity?`, `cost?` | `EnrollProduct`                                  |
| `propose_receipt_confirm`      | propose | `receipt_id`                                                 | `EnrollProduct`                                  |
| `propose_repayment`            | propose | `customer_id`, `amount`, `method`                            | `RecordDebt`                                     |
| `propose_debt_adjustment`      | propose | `customer_id`, `amount`, `reason` (write-off, fix)           | `AdjustDebt`                                     |
| `propose_invite`               | propose | `role`, `can_enroll`                                         | `ManageInvites`                                  |

Rules:

- The tool list sent to the model contains only the tools the caller may use. A tool still
  re-checks its permission when it runs.
- Money is integer đồng, as everywhere in the API. Dates are business dates in
  `Asia/Ho_Chi_Minh`. Relative dates ("hôm qua", "tuần này") are resolved by the model against
  the `today` value in the system prompt.
- Tools return at most 50 rows and a `truncated` flag.
- `get_tax_overview` reads a versioned rule table in the repo (`assistant/rules/tax_vn.toml`)
  with source links and an effective date. The epic must check the current regulation before
  writing the table, and the answer always states the rule version and that the owner should
  confirm with the tax office.
- `search_help` reads Vietnamese Markdown articles in `apps/backend/crates/api/src/assistant/help/`.
- `get_debts`, `draft_debt_reminder`, `propose_repayment` and `propose_debt_adjustment` are
  built by X5 after X3's tool registry is on `main`.

## Proposed actions

```
proposed ──Confirm──▶ executing ──▶ done (result: entity ids)
   │                      └──────▶ failed (error code, message)
   ├──Reject────────────▶ rejected
   └──24 h, or entity changed────▶ expired
```

- Stored in `assistant_actions` with `kind`, validated `payload`, `thread_id`, `message_id`,
  proposer member, status and result.
- Confirm (`POST /v1/assistant/actions/{id}/confirm`, `Idempotency-Key` required) runs the same
  service function the normal handler uses, with the **confirming** member's `Actor` and
  permission check. A replay returns the first result.
- A confirmed or rejected action is fed back to the model as a short system note in the next
  turn so the conversation stays consistent.
- Expiry: a proposal older than 24 hours, or whose target changed since it was drafted
  (product price, receipt status), cannot be confirmed (409 `action_stale`).

## Agent loop

- System prompt (Vietnamese, versioned file `assistant/prompts/system.vi.md`, plus `en`):
  role, store name, member role, today's business date, the language, rules (answer only from
  tool data, say when data is missing, never invent numbers, propose instead of claiming a
  write, refuse other-store or permission-denied requests, keep answers short with numbers
  formatted as `1.234.000 ₫`).
- Loop: at most 6 model calls per user message; tool calls in one model turn run in parallel;
  each tool has a 5 s timeout.
- Models: `ASSISTANT_MODELS` is an ordered comma-separated list of free tool-capable OpenRouter
  models; the next model is used on 429, 5xx, timeout or invalid tool-call JSON (use OpenRouter
  model fallback routing when its current docs support it). The golden set picks the order.
- Quota: `ASSISTANT_DAILY_MESSAGES_PER_STORE` (default 60) in Redis per store and business date.
  When the store cap or the OpenRouter daily quota is hit, the reply is a friendly Vietnamese
  message and a `quota` SSE error; no model call is made.
- Context: the last 20 messages of the thread plus tool results; longer threads drop the oldest
  tool results first.
- Prompt injection: product names, OCR text, notes and customer names are data. The golden set
  includes injection cases; the assistant must not follow them.

## API contract (X0 writes it into `docs/api/openapi.yaml`)

| Method and path                                   | Purpose                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /v1/assistant/threads`                      | Create a thread `{title?, context?: {screen, next_step_id?, receipt_id?, image_id?}}`                   |
| `GET /v1/assistant/threads`                       | Caller's threads, cursor pagination, newest first                                                       |
| `GET /v1/assistant/threads/{id}`                  | Thread with messages, tool-call summaries and actions                                                   |
| `DELETE /v1/assistant/threads/{id}`               | Delete own thread                                                                                       |
| `POST /v1/assistant/threads/{id}/messages`        | Send `{content, attachments?: [{image_id} or {receipt_id}], language}`; response is `text/event-stream` |
| `POST /v1/assistant/actions/{id}/confirm`         | Execute a proposed action (`Idempotency-Key`)                                                           |
| `POST /v1/assistant/actions/{id}/reject`          | Reject a proposed action                                                                                |
| `POST /v1/assistant/messages/{id}/feedback`       | `{rating: up or down, comment?}`; becomes a PostHog LLM feedback event                                  |
| `GET /v1/assistant/next-steps`                    | Ranked chips for `?screen=camera&document_detected=&unknown_product=`                                   |
| `GET /v1/assistant/digest`                        | Daily digest for `?business_date=` (X8)                                                                 |
| `POST /v1/devices` / `DELETE /v1/devices/{token}` | Register / remove an Expo push token (X8)                                                               |

SSE events on the message stream (`event:` name, JSON `data:`):

| Event               | Data                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| `message.created`   | `{message_id, thread_id}`                                                    |
| `message.delta`     | `{text}`                                                                     |
| `tool.started`      | `{call_id, tool, label_vi}` (label is shown as a status line)                |
| `tool.finished`     | `{call_id, tool, ok, summary_vi}`                                            |
| `action.proposed`   | full `AssistantAction`                                                       |
| `card`              | structured card (`receipt_lines`, `restock_list`, `debt_list`, `chart_bars`) |
| `message.completed` | `{message_id, model, usage: {input_tokens, output_tokens}}`                  |
| `error`             | `{code: quota, model_unavailable, timeout, internal, message_vi}`            |

AsyncAPI: `assistant.action.confirmed` and `assistant.action.rejected` (for analytics and the
change feed).

## Data model (X3, migrations `08xx`)

- `assistant_threads(id, store_id, member_id, title, context jsonb, created_at, updated_at)`
- `assistant_messages(id, thread_id, store_id, role, content, tool_calls jsonb, model,
input_tokens, output_tokens, trace_id, created_at)`
- `assistant_actions(id, store_id, thread_id, message_id, kind, payload jsonb, status,
proposed_by, decided_by, decided_at, result jsonb, error jsonb, expires_at, created_at)`
- `assistant_feedback(message_id, member_id, rating, comment, created_at)`
- All tables start indexes with `store_id`; threads are visible only to their member.

## Next-step strip

`GET /v1/assistant/next-steps` returns at most 8 chips, ranked by priority, computed by SQL
rules in under 50 ms p95 (no model call). The phone adds on-device context chips (document
detected, unknown product) in front. Each chip: `{id, kind, title_vi, subtitle_vi?, priority,
action: {type: navigate, route} or {type: chat, prompt_vi, context}}`.

| Kind               | Rule                                                         | Action                               |
| ------------------ | ------------------------------------------------------------ | ------------------------------------ |
| `receipt_detected` | phone: `document.detected` on the current frame              | chat: receipt thread (U14)           |
| `unknown_product`  | phone: unknown match on the current frame                    | navigate `/enroll`                   |
| `restock`          | at least one tracked product at or below its threshold       | chat: "Lên danh sách nhập hàng" (U1) |
| `draft_receipts`   | receipts in draft                                            | navigate `/receipts`                 |
| `overdue_debts`    | customers with debt older than 7 days                        | navigate debt book (U23)             |
| `day_close`        | after 20:00 local time and no chốt sổ for today (Lead)       | navigate `/close`                    |
| `review_queue`     | manual lines waiting (Lead)                                  | chat: triage (U6)                    |
| `digest`           | today's digest exists and is unread                          | open digest card (U13)               |
| `setup`            | setup checklist incomplete (Lead, first 14 days)             | chat: setup helper (U21)             |
| `margin_alert`     | a confirmed receipt raised cost above price minus 5 % (Lead) | chat: margin check (U3)              |

Analytics: `next_step_shown` (per chip, once per screen visit) and `next_step_tapped`.

## Mobile UI (X4)

- **Chat button:** round button at the bottom right, directly beside (above-right of) the shop
  tab bar, on all shop tabs and the camera screen; it never covers the shutter or tab targets.
  Opens the assistant as a full-height sheet with the last thread, a thread list and a "new
  chat" action.
- **Chat screen:** streaming text, tool status lines (`label_vi`), structured cards, proposed
  action cards with Confirm / Reject (Confirm sends `Idempotency-Key` = action id), thumbs up /
  down per assistant message, retry on error, quota message.
- **Voice:** hold-to-talk microphone in the input, on-device recognition `vi-VN` (or `en-US`),
  partial results shown live, release to fill the input (not auto-send).
- **Next-step strip:** one horizontally scrolling row of chips directly under the camera frame,
  snap scrolling, swipe left and right, haptic on tap; hidden when empty; does not change
  existing buttons.
- **Receipt in chat (U14):** the `receipt_detected` chip uploads the frame, creates the receipt
  (`POST /v1/receipts`), opens a thread with `context.receipt_id`. The assistant posts a
  `receipt_lines` card (name, quantity, cost, matched product, confidence colour), asks about
  unmatched or low-confidence lines one at a time, accepts fixes by text, voice or tapping a
  line, and ends with a `propose_receipt_confirm` card. "Xem dạng bảng" opens the existing
  receipt screen for the same receipt.
- **i18n:** every string in `vi` and `en` dictionaries; Vietnamese default.
- **Accessibility:** buttons at least 48 dp, labels for screen readers, text scales.
