-- oracle: receipt_draft_line_quantity
-- kind: count
-- args: product product
-- uses: U14
-- describe: Quantity on the draft receipt line matched to a product.
-- example: {"product":"Nước mắm Nam Ngư 500ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product),
draft AS (
  SELECT r.id
  FROM receipts r
  JOIN ctx ON ctx.store_id = r.store_id
  WHERE r.status = 'draft'
  ORDER BY r.created_at DESC, r.id
  LIMIT 1
)
SELECT l.quantity AS quantity
FROM receipt_lines l
JOIN draft ON draft.id = l.receipt_id
JOIN products p ON p.id = l.product_id AND p.name = (SELECT product FROM ctx)
