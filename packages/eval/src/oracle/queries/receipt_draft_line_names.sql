-- oracle: receipt_draft_line_names
-- kind: names
-- uses: U14
-- describe: Product names as printed on the lines of the draft receipt (upper case, no diacritics), in line order.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today),
draft AS (
  SELECT r.id
  FROM receipts r
  JOIN ctx ON ctx.store_id = r.store_id
  WHERE r.status = 'draft'
  ORDER BY r.created_at DESC, r.id
  LIMIT 1
)
SELECT l.product_name
FROM receipt_lines l
JOIN draft ON draft.id = l.receipt_id
ORDER BY l.position
