-- oracle: receipt_draft_matched_names
-- kind: names
-- uses: U14
-- describe: Catalog products matched to the lines of the draft receipt, in line order (unmatched lines have none).
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today),
draft AS (
  SELECT r.id
  FROM receipts r
  JOIN ctx ON ctx.store_id = r.store_id
  WHERE r.status = 'draft'
  ORDER BY r.created_at DESC, r.id
  LIMIT 1
)
SELECT p.name
FROM receipt_lines l
JOIN draft ON draft.id = l.receipt_id
JOIN products p ON p.id = l.product_id
ORDER BY l.position
