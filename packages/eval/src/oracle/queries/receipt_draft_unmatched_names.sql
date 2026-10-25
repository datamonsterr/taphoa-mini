-- oracle: receipt_draft_unmatched_names
-- kind: names
-- uses: U14
-- describe: Lines of the draft receipt with no catalog match, as printed (upper case, no diacritics). The name scorer folds diacritics only when the answer has none, so prefer receipt_draft_unmatched_count in facts.
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
WHERE l.product_id IS NULL
ORDER BY l.position
