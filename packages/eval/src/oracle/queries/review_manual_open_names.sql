-- oracle: review_manual_open_names
-- kind: names
-- uses: U6
-- describe: The labels of the open manual lines, as the seller typed them, oldest first.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT l.manual_label
FROM sale_lines l
JOIN ctx ON ctx.store_id = l.store_id
JOIN sales s ON s.id = l.sale_id
WHERE l.source = 'manual'
  AND l.review_status = 'open'
ORDER BY s.sold_at, l.position
