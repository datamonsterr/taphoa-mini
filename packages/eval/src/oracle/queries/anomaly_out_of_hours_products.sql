-- oracle: anomaly_out_of_hours_products
-- kind: names
-- args: period period
-- uses: U9
-- describe: Products sold in the out-of-hours sales of a period, oldest sale first. Lead only.
-- example: {"period":"year_to_date"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
SELECT p.name
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
JOIN sale_lines l ON l.sale_id = s.id
JOIN products p ON p.id = l.product_id
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
  AND ((s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time < TIME '06:30'
       OR (s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time > TIME '21:30')
ORDER BY s.sold_at, l.position
