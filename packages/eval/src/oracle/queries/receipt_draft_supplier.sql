-- oracle: receipt_draft_supplier
-- kind: names
-- uses: U14
-- describe: Supplier of the draft receipt (receipts.supplier).
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT r.supplier
FROM receipts r
JOIN ctx ON ctx.store_id = r.store_id
WHERE r.status = 'draft'
  AND r.supplier IS NOT NULL
ORDER BY r.created_at DESC, r.id
LIMIT 1
