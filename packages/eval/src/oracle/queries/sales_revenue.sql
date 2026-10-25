-- oracle: sales_revenue
-- kind: money
-- args: period period
-- uses: U2, U10, U13, U22
-- describe: Revenue of completed (not voided) sales in a period, in dong. Also the revenue for tax questions: pass this_month, last_month, this_quarter or year_to_date.
-- example: {"period":"yesterday"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
SELECT COALESCE(SUM(s.total), 0)::bigint AS revenue
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
