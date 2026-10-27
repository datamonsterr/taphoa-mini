-- oracle: sales_count
-- kind: count
-- args: period period
-- uses: U2, U13
-- describe: Number of completed (not voided) sales in a period.
-- example: {"period":"yesterday"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
SELECT COUNT(*)::int AS sale_count
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
