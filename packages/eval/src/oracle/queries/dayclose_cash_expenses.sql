-- oracle: dayclose_cash_expenses
-- kind: money
-- args: date date
-- uses: U5
-- describe: Expenses paid from the cash box on a business date, in dong. Lead only.
-- example: {"date":"2026-10-14"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS day)
SELECT COALESCE(SUM(e.amount), 0)::bigint AS cash_expenses
FROM expenses e
JOIN ctx ON ctx.store_id = e.store_id
WHERE e.paid_with = 'cash_box'
  AND e.deleted_at IS NULL
  AND e.business_date = ctx.day
