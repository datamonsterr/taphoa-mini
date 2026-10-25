# Debt book (sổ nợ)

Status: Accepted · Date: 2026-10-25 · Program: [README](README.md) · Epic: X5

## Goal

Let a member sell on credit at checkout (fully or partly), record repayments, see who owes
what and send a reminder, without leaving the main (camera and checkout) screen.

## Rules

- A **customer** has a name, optional phone, optional note and optional credit limit. Going
  over the limit warns; it never blocks the sale.
- A **credit sale** adds the unpaid part of a sale to the customer's debt. The paid part, if
  any, is cash or transfer as today.
- A **repayment** reduces debt; method cash or transfer. Cash repayments add to chốt sổ
  expected cash for their business date; the credit part of a sale never does.
- Voiding a sale with credit automatically adds a reversing debt entry.
- Debt age: repayments settle the oldest credit first (FIFO). A customer is overdue when the
  oldest unsettled credit is older than 7 days (store setting later).
- Sellers create customers, record credit sales and repayments. Only the Lead adjusts debt
  (write-off, correction) or archives a customer.
- Customer names and phones are personal data: never in telemetry attributes or logs.

## Data model (`09xx`)

- `customers(id, store_id, name, phone NULL, note NULL, credit_limit NULL, balance BIGINT NOT
NULL DEFAULT 0, archived_at NULL, created_at, updated_at)`; index `(store_id, lower(name))`.
- `debt_entries(id, store_id, customer_id, kind credit_sale | repayment | adjustment | void,
amount BIGINT signed (positive increases debt), sale_id NULL, method cash | transfer NULL,
reason NULL, member_id, business_date, created_at, request_hash)`; index
  `(store_id, customer_id, created_at)`.
- `customers.balance` is updated in the same transaction as each entry.
- `sales`: `payment_method` gains `credit`; new nullable `customer_id`, `credit_amount BIGINT
NOT NULL DEFAULT 0` with check `0 <= credit_amount <= total`; `credit` requires
  `credit_amount = total`; `cash` or `transfer` with `credit_amount > 0` is a partial credit sale.
- Permission actions `RecordDebt` (all members) and `AdjustDebt` (Lead) in `auth::Action`.

## API (X5 edits `docs/api/openapi.yaml` and `asyncapi.yaml`)

| Method and path                                      | Purpose                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /v1/customers`                                  | Search `?query=&overdue=&cursor=`; includes balance and oldest debt age |
| `POST /v1/customers`                                 | Create (`RecordDebt`)                                                   |
| `GET /v1/customers/{id}`, `PATCH /v1/customers/{id}` | Read / edit; archive is Lead only                                       |
| `GET /v1/customers/{id}/entries`                     | Ledger, newest first, cursor pagination                                 |
| `POST /v1/customers/{id}/repayments`                 | `{amount, method}`, `Idempotency-Key` (`RecordDebt`)                    |
| `POST /v1/customers/{id}/adjustments`                | `{amount, reason}`, `Idempotency-Key` (`AdjustDebt`)                    |
| `GET /v1/debts/summary`                              | Total outstanding, overdue count, top 5 debtors                         |
| `createSale`                                         | `payment_method: credit` and optional `credit: {customer_id, amount}`   |
| `getDayClose` / `putDayClose`                        | Expected cash includes cash repayments; response lists credit totals    |

Events: `customer.created`, `customer.updated`, `debt.recorded`, `debt.repaid`, `debt.adjusted`
through the outbox; customers and debt entries join the change feed for the phone replica.
Offline credit sales and repayments replay idempotently through the existing outbox.

## Mobile

- **Pay sheet:** a third option "Ghi nợ" next to cash and transfer. It opens a customer picker
  (search, recent customers, create inline with name and optional phone) and an amount field
  "Trả trước" (paid now, default 0). Over-limit shows a warning line.
- **Debt book screen** (`/debts`): list with balance and overdue badge, search, total
  outstanding at the top. Opened from the `overdue_debts` chip in the next-step strip and from
  a dashboard card. No new button on the camera screen.
- **Customer screen:** balance, ledger, "Thu nợ" (repayment sheet), "Nhắc nợ" (system share
  sheet with a Vietnamese reminder text including the balance and the store's VietQR when set),
  Lead-only "Điều chỉnh".
- **Day close:** shows cash repayments and credit sales as separate lines.

## Assistant tools (last task, after X3's tool registry is on `main`)

`get_debts`, `draft_debt_reminder`, `propose_repayment`, `propose_debt_adjustment` as defined in
[assistant.md](assistant.md), the `overdue_debts` next-step rule, and golden cases for U23.

## Tests

- Rust unit: FIFO aging, balance updates, partial credit validation, void reversal.
- Integration (`tests/debts.rs`): concurrent repayments keep the balance exact; idempotent
  replay; seller cannot adjust; day-close expected cash with repayments.
- E2E `packages/e2e/tests/debts.test.ts` on Railway `test`; Jest for the pay sheet, picker and
  screens; Maestro and Playwright flow "sell on credit, repay, see zero balance".
