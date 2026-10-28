# X5 · Debt book: task graph

Status: Done · Merge: [#32](https://github.com/datamonsterr/taphoa-mini/pull/32) and [#42](https://github.com/datamonsterr/taphoa-mini/pull/42) (T6) · Date: 2026-10-25 · Epic: X5 · Spec: [debt-book.md](debt-book.md) ·
Branch: `epic/x5-debt-book`

The controller session plans, briefs, reviews and merges. Workers edit source through
superorchestrator (fallback: native subagents). Every task lands failing tests first.

## Decisions made by this epic

These refine [debt-book.md](debt-book.md). They do not change any program decision.

### Data model (`0901_debt_book.sql`)

- `customers` as specified, plus `oldest_debt_date DATE NULL` (business date of the oldest
  unsettled credit, maintained in the same transaction as each entry) and `request_hash BYTEA`
  (create replay). `id` is a client UUIDv7, so the pay sheet can create a customer offline.
  Indexes `(store_id, lower(name))` and `(store_id, oldest_debt_date) WHERE balance > 0`.
- `debt_entries` as specified, plus `balance_after BIGINT NOT NULL` and `key_hash BYTEA NULL`
  (hash of the `Idempotency-Key`, unique per store when set). `request_hash` is nullable:
  credit-sale and void entries are idempotent through their sale.
- `sales`: `payment_method` check adds `credit`; `customer_id UUID NULL REFERENCES customers`,
  `credit_amount BIGINT NOT NULL DEFAULT 0`, check `0 <= credit_amount <= total`, check
  `(credit_amount > 0) = (customer_id IS NOT NULL)`, check `payment_method <> 'credit' OR
credit_amount = total`. The `cash_received >= total` check becomes
  `cash_received >= total - credit_amount`.
- `day_closes` gains `cash_repayments`, `transfer_repayments` and `credit_sales`
  (`BIGINT NOT NULL DEFAULT 0`).
- `change_log.entity` check adds `customer` and `debt_entry`. The migration drops and re-adds
  `change_log_entity_check` with the full list. Any later epic that changes this check must
  keep every value.

### Rules

- **Amounts.** `debt_entries.amount` is signed: positive increases debt. `credit_sale` > 0,
  `void` < 0, `repayment` < 0, `adjustment` is nonzero either way. API inputs for repayments
  are positive; the server stores the negative amount.
- **Aging (FIFO).** A void entry cancels exactly its own sale's credit entry; both are left out
  of aging. The remaining positive entries are credits, ordered by
  `(business_date, created_at, id)`. The sum of the remaining negative entries settles them
  oldest first. `oldest_debt_date` is the business date of the first credit not fully settled,
  or null when the balance is at most 0. `debt_age_days = today − oldest_debt_date`
  (business dates, `Asia/Ho_Chi_Minh`). **Overdue** means `debt_age_days > 7`.
- **Overpayment** is allowed (offline replays must never fail permanently). A negative balance
  means the store holds the customer's money. The app warns before it sends one.
- **Credit limit** never blocks. The app shows the warning; the server only stores the limit.
- **Archived customers** are hidden from lists by default. Credit sales and repayments for them
  still succeed (offline safety).
- **Credit sale.** `payment_method=credit` needs `credit.amount = total` and no
  `cash_received`. `cash` or `transfer` with `credit` needs `0 < credit.amount < total`.
  `cash_received` must cover the paid part `total − credit.amount`; `change_given` uses the
  paid part. An unknown customer is 404. The sale and its `credit_sale` entry commit together.
- **Void** of a sale with credit adds a `void` entry of `−credit_amount` with the void's
  business date, in the void transaction. Voiding twice adds nothing.
- **Business date** of a repayment or adjustment comes from optional device time
  (`paid_at`, `adjusted_at`, default server time), as for sale voids.
- **Day close.** `cash_sales` and `cash_refunds` count only the paid part
  (`total − credit_amount`) of cash sales. `transfer_revenue` counts only the paid part of
  transfer sales. `cash_repayments` and `transfer_repayments` sum repayment entries of that
  business date by method. `credit_sales` sums `credit_amount` of completed sales of that date.
  `expected_cash = opening_float + cash_sales − cash_refunds + cash_repayments − cash_expenses`.
- **Reports.** Revenue stays the full sale total (credit sales are revenue). Any existing
  cash/transfer split counts only the paid part; if the report states that the split sums to
  revenue, it gains `credit_revenue`.
- **Lock order** (deadlock rule): products, then the customer row (`FOR UPDATE`), then the store
  row (taken by `events::emit`). A credit sale locks its customer right after
  `stock::lock_products` and before the first `emit`.
- **Permissions.** `RecordDebt` (all members): list, read, create and edit customers, credit
  sales, repayments, summary. `AdjustDebt` (Lead): adjustments and `archived` changes.
- **Idempotency.** `POST /v1/customers` replays on `id` like sales (201, then 200, 409 on a
  different body). Repayments and adjustments require `Idempotency-Key` (422 when missing,
  like stock adjustments); a replay returns 200 with the same entry; the same key with another
  body or customer is 409 `id_conflict`.
- **Events** (outbox; no names, phones or notes in payloads):
  - `customer.created` and `customer.updated` `{customer_id, balance, archived}`, change
    `customer` upsert. Every entry also emits `customer.updated`, so the replica gets the new
    balance.
  - `debt.recorded` `{entry_id, customer_id, kind (credit_sale, void), amount, sale_id,
balance, business_date}`, change `debt_entry` upsert.
  - `debt.repaid` `{entry_id, customer_id, amount (positive), method, balance, business_date}`,
    change `debt_entry` upsert.
  - `debt.adjusted` `{entry_id, customer_id, amount (signed), balance, business_date}`, change
    `debt_entry` upsert.
  - `sale.created` data gains `credit_amount` and `customer_id`.
- **Telemetry.** Customer names, phones and notes never appear in span attributes, logs or
  event payloads.

### API additions (summary; `docs/api/openapi.yaml` is the source of truth)

- Schemas `Customer`, `CreateCustomerRequest`, `UpdateCustomerRequest`, `CustomerList`,
  `DebtEntry`, `DebtEntryList`, `CreateRepaymentRequest`, `CreateDebtAdjustmentRequest`,
  `DebtSummary`, `SaleCredit`.
- `Customer`: `id, name, phone, note, credit_limit, balance, oldest_debt_date, debt_age_days,
overdue, archived, created_at, updated_at`.
- `DebtEntry`: `id, customer_id, kind, amount, balance_after, sale_id, method, reason,
member_id, business_date, created_at`.
- `GET /v1/customers`: `query` (case-insensitive substring of name or phone), `overdue`,
  `archived` (default false), `sort` (`balance` default, `recent`, `name`), `limit`, `cursor`.
- `DebtSummary`: `total_outstanding` (sum of positive balances), `customers_with_debt`,
  `overdue_count`, `overdue_amount`, `top_debtors` (at most 5 customers, balance > 0, largest
  first).
- `PaymentMethod` adds `credit`; `CreateSaleRequest.credit` is `SaleCredit {customer_id,
amount}`; `Sale` gains `credit_amount` (always present) and `customer_id` (nullable).
- `DayClose` gains `cash_repayments`, `transfer_repayments`, `credit_sales`.
- `Change.entity` adds `customer`, `debt_entry`; `StoreEvent.type` adds the five debt events.

## Task graph

```
T1 contract ──┬── T2a backend ledger ── T2b sales, void, day close ──┐
              └── T3a mobile API, mock, pay sheet ── T3b screens ─────┴── T4 e2e + flows ── T5 review, deploy test, PR, merge
                                                          (after X3 on main) T6 assistant debt tools, follow-up PR
```

| Task | Scope                                                                                                                                                                                                                                                         | Tests first                                                                                                                                                                | Worker route               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| T1   | Debt sections of `openapi.yaml` and `asyncapi.yaml`; regenerate `packages/api-client/src/schema.d.ts`                                                                                                                                                         | `tests/asyncapi.rs` samples for the five events and the new `sale.created` fields; api-client typecheck                                                                    | codex `gpt-6.1-sol` medium |
| T2a  | `0901` migration; `RecordDebt` / `AdjustDebt`; `debts/` module: customers CRUD, ledger write function, FIFO aging, repayments, adjustments, summary, events, change feed entities                                                                             | unit: FIFO aging, balance math; `tests/debts.rs`: CRUD, concurrent repayments, idempotent replay, seller cannot adjust, contract conformance, feed rows                    | codex `gpt-6.1-sol` high   |
| T2b  | Credit sale in `sales/`, void reversal, day-close expected cash and credit lines, report split, `sale.created` fields                                                                                                                                         | unit: partial credit validation; `tests/debts.rs`: credit sale + replay, partial, void reversal, day close with repayments; existing `sales*.rs`, `reports*.rs` stay green | codex `gpt-6.1-sol` high   |
| T3a  | `lib/api/debts.ts` hooks; mock handlers for customers, entries, repayments, adjustments, summary and credit sales; pay sheet "Ghi nợ" with customer picker (search, recent, inline create) and "Trả trước"; over-limit warning                                | Jest: mock handlers, picker, pay sheet credit flow                                                                                                                         | codex `gpt-6.1-sol` medium |
| T3b  | `/debts` debt book, `/customer/[id]` customer screen (ledger, "Thu nợ", "Nhắc nợ" share, Lead-only "Điều chỉnh"), dashboard debt card, close screen lines                                                                                                     | Jest for each screen and the reminder text                                                                                                                                 | codex `gpt-6.1-sol` medium |
| T4   | `packages/e2e/tests/debts.test.ts`; Playwright `e2e-web/debts.spec.ts` and Maestro `.maestro/debts.yaml` ("sell on credit, repay, see zero balance")                                                                                                          | the specs themselves                                                                                                                                                       | codex `gpt-6-luna` medium  |
| T5   | Rebase on `main`; `/code-review`; branch deploy to Railway `test` (`gh workflow run deploy.yml -f ref=epic/x5-debt-book`) after X0's migrator tolerance is on `main`; e2e green; PR; merge commit; watch `Deploy backend` to production smoke; clean worktree | `ci-ok`, e2e on `test`                                                                                                                                                     | controller                 |
| T6   | After X3's tool registry is on `main`: `get_debts`, `draft_debt_reminder`, `propose_repayment`, `propose_debt_adjustment`, the `overdue_debts` next-step rule, U23 golden cases; follow-up PR                                                                 | tool unit tests against fixtures, permission filtering, propose never writes before Confirm                                                                                | codex `gpt-6.1-sol` high   |

## Gates and coordination

- Branch deploys to the shared `test` database wait until X0's migrator tolerance is on
  `main`; otherwise a later `main` deploy fails on the unknown `0901` version.
- `0901` is immutable once deployed to `test`.
- X1 changes `Actor` and the e2e helpers; rebase on `main` before T4 and before the PR.
- App analytics use `apps/mobile/src/lib/analytics.ts` once X0 lands it; until then no app
  events are added (backend debt events go through the outbox).

## Workers

Codex accounts hit their quota on 2026-10-25, so T2b onward run on native subagents
(`claude-sonnet-5-5`), per the fallback rule.

## Version pins

None new. The epic uses the repository's current crates and packages.

## Progress

| Task | State       | Notes                                                                                                    |
| ---- | ----------- | -------------------------------------------------------------------------------------------------------- |
| T1   | done        | `1f8f9b7` contract                                                                                       |
| T2a  | done        | `ec6ed33` ledger, FIFO, feed; review fixes go with T2b                                                   |
| T2b  | done        | `f01fcd6` credit sales, void reversal, day close; `8fcaede` review fixes                                 |
| T3a  | done        | `d0ab9ba` pay sheet Ghi nợ, picker, mock                                                                 |
| T3b  | done        | `51ea497` debt book, customer screen, reminder, dashboard card, close lines                              |
| T4   | done        | `9417b8f`, `109f07b`, `55597d0`; debts e2e 9/9 on `test`, Playwright and Maestro debts flows green in CI |
| T5   | in progress | PR #32; review fixes `f377736`, `7cf83e5`, `0eee87e`                                                     |
| T6   | waiting     | X3                                                                                                       |
