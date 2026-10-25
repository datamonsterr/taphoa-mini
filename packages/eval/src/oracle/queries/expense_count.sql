-- oracle: expense_count
-- kind: count
-- args: category expense_category, period period
-- uses: U16
-- describe: Number of expenses in a period for one category (nhap_hang, dien, nuoc, khac) or all; deleted expenses are left out.
-- example: {"category":"dien","period":"this_week"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS category, $4::date AS period_from, $5::date AS period_to)
SELECT COUNT(*)::int AS expenses
FROM expenses e
JOIN ctx ON ctx.store_id = e.store_id
WHERE e.deleted_at IS NULL
  AND (ctx.category = 'all' OR e.category = ctx.category)
  AND e.business_date BETWEEN ctx.period_from AND ctx.period_to
