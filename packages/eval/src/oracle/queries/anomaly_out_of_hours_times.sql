-- oracle: anomaly_out_of_hours_times
-- kind: names
-- args: period period
-- uses: U9
-- describe: Local time (YYYY-MM-DD HH:MM, Asia/Ho_Chi_Minh) of each out-of-hours sale, oldest first. For rubrics and the judge only; the scorers cannot match dates or times in an answer.
-- example: {"period":"year_to_date"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
SELECT to_char(s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI') AS sold_local
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
  AND ((s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time < TIME '06:30'
       OR (s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time > TIME '21:30')
ORDER BY s.sold_at
