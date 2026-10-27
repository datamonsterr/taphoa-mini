-- oracle: anomaly_out_of_hours_count
-- kind: count
-- args: period period
-- uses: U9
-- describe: Completed sales rung up outside the regular opening hours (before 06:30 or after 21:30, Asia/Ho_Chi_Minh) in a period. Lead only.
-- example: {"period":"year_to_date"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
SELECT COUNT(*)::int AS out_of_hours
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
  AND ((s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time < TIME '06:30'
       OR (s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time > TIME '21:30')
