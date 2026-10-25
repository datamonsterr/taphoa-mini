-- oracle: sales_void_count
-- kind: count
-- args: period period
-- uses: U5, U8, U9
-- describe: Number of voided sales in a period (by business date of the sale).
-- example: {"period":"2026-10-14"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
SELECT COUNT(*)::int AS void_count
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
WHERE s.status = 'voided'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
