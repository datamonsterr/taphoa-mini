-- oracle: expense_cash_total
-- kind: money
-- args: category expense_category, period period
-- uses: U16
-- describe: Expenses paid from the cash box in a period for one category (nhap_hang, dien, nuoc, khac) or all, in dong.
-- example: {"category":"dien","period":"this_week"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS category, $4::date AS period_from, $5::date AS period_to)
SELECT COALESCE(SUM(e.amount), 0)::bigint AS cash_total
FROM expenses e
JOIN ctx ON ctx.store_id = e.store_id
WHERE e.deleted_at IS NULL
  AND e.paid_with = 'cash_box'
  AND (ctx.category = 'all' OR e.category = ctx.category)
  AND e.business_date BETWEEN ctx.period_from AND ctx.period_to
