-- oracle: sales_revenue_change_pct
-- kind: percent
-- args: period period, versus period
-- uses: U2, U13
-- describe: Revenue change of a period against another period, in percent (positive means growth), over completed sales. Both periods should have the same length.
-- example: {"period":"last_7_days","versus":"prev_7_days"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to, $5::date AS versus_from, $6::date AS versus_to),
cur AS (
  SELECT COALESCE(SUM(s.total), 0) AS revenue
  FROM sales s
  JOIN ctx ON ctx.store_id = s.store_id
  WHERE s.status = 'completed' AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
),
prev AS (
  SELECT COALESCE(SUM(s.total), 0) AS revenue
  FROM sales s
  JOIN ctx ON ctx.store_id = s.store_id
  WHERE s.status = 'completed' AND s.business_date BETWEEN ctx.versus_from AND ctx.versus_to
)
SELECT ROUND((cur.revenue - prev.revenue) * 100.0 / NULLIF(prev.revenue, 0), 1) AS change_pct
FROM cur, prev
