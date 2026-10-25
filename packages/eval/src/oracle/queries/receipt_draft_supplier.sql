-- oracle: receipt_draft_supplier
-- kind: names
-- uses: U14
-- describe: Supplier of the draft receipt, spelled as in the store's confirmed receipts (the first OCR line, matched to a confirmed receipt of the same supplier).
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today),
draft AS (
  SELECT r.id, r.store_id, split_part(r.ocr_text, E'\n', 1) AS header
  FROM receipts r
  JOIN ctx ON ctx.store_id = r.store_id
  WHERE r.status = 'draft'
  ORDER BY r.created_at DESC, r.id
  LIMIT 1
)
SELECT COALESCE(
  (SELECT regexp_replace(e.note, '^Nhập hàng: ', '')
   FROM receipts r2
   JOIN expenses e ON e.id = r2.expense_id
   WHERE r2.store_id = draft.store_id
     AND r2.status = 'confirmed'
     AND split_part(r2.ocr_text, E'\n', 1) = draft.header
   ORDER BY r2.confirmed_at DESC
   LIMIT 1),
  draft.header
) AS supplier
FROM draft
