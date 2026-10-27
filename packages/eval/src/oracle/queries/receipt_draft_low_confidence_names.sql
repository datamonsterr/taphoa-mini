-- oracle: receipt_draft_low_confidence_names
-- kind: names
-- uses: U14
-- describe: Catalog products matched to draft receipt lines with a match confidence under 0.8, lowest first.
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
WHERE l.match_confidence < 0.8
ORDER BY l.match_confidence, l.position
