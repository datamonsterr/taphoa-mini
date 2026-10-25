-- oracle: receipt_draft_low_confidence_alt_names
-- kind: names
-- uses: U14
-- describe: The alternative candidates offered for the low-confidence draft receipt lines (the matched product itself left out), best first.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today),
draft AS (
  SELECT r.id
  FROM receipts r
  JOIN ctx ON ctx.store_id = r.store_id
  WHERE r.status = 'draft'
  ORDER BY r.created_at DESC, r.id
  LIMIT 1
)
SELECT c.candidate ->> 'name' AS alternative
FROM receipt_lines l
JOIN draft ON draft.id = l.receipt_id
CROSS JOIN LATERAL jsonb_array_elements(l.candidates) WITH ORDINALITY AS c(candidate, rank)
WHERE l.product_id IS NOT NULL
  AND l.match_confidence < 0.8
  AND (c.candidate ->> 'product_id')::uuid <> l.product_id
ORDER BY l.position, c.rank
