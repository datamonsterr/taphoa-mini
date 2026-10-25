-- oracle: sales_cash_revenue
-- kind: money
-- args: period period
-- uses: U2, U5
-- describe: Revenue of completed sales paid in cash in a period, in dong (transfer sales excluded).
-- example: {"period":"2026-10-14"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
SELECT COALESCE(SUM(s.total), 0)::bigint AS cash_revenue
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
WHERE s.status = 'completed'
  AND s.payment_method = 'cash'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
