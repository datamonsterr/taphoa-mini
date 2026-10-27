-- oracle: receipt_draft_unmatched_count
-- kind: count
-- uses: U14
-- describe: Number of draft receipt lines with no catalog match.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today),
draft AS (
  SELECT r.id
  FROM receipts r
  JOIN ctx ON ctx.store_id = r.store_id
  WHERE r.status = 'draft'
  ORDER BY r.created_at DESC, r.id
  LIMIT 1
)
SELECT COUNT(*)::int AS unmatched
FROM receipt_lines l
JOIN draft ON draft.id = l.receipt_id
WHERE l.product_id IS NULL
