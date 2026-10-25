-- oracle: receipt_draft_unmatched_closest_names
-- kind: names
-- uses: U14
-- describe: The closest catalog candidate the matcher offered for each unmatched draft receipt line, in line order.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today),
draft AS (
  SELECT r.id
  FROM receipts r
  JOIN ctx ON ctx.store_id = r.store_id
  WHERE r.status = 'draft'
  ORDER BY r.created_at DESC, r.id
  LIMIT 1
)
SELECT l.candidates -> 0 ->> 'name' AS closest
FROM receipt_lines l
JOIN draft ON draft.id = l.receipt_id
WHERE l.product_id IS NULL
  AND jsonb_array_length(l.candidates) > 0
ORDER BY l.position
