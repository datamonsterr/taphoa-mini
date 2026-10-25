-- oracle: review_manual_open_count
-- kind: count
-- uses: U6
-- describe: Open manual lines waiting in the review queue (sold by typing a label, no product). Price-mismatch lines are separate.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT COUNT(*)::int AS open_manual_lines
FROM sale_lines l
JOIN ctx ON ctx.store_id = l.store_id
WHERE l.source = 'manual'
  AND l.review_status = 'open'
