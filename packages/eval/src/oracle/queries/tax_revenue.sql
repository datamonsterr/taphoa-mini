-- oracle: tax_revenue
-- kind: money
-- args: period period
-- uses: U10
-- describe: Revenue for the tax helper: completed sales in a month, quarter or year to date, in dong. Pass this_month, last_month, YYYY-MM, this_quarter, last_quarter or year_to_date.
-- example: {"period":"year_to_date"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
SELECT COALESCE(SUM(s.total), 0)::bigint AS revenue
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
