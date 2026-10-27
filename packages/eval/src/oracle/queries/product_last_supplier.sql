-- oracle: product_last_supplier
-- kind: names
-- args: product product
-- uses: U1, U17
-- describe: The supplier of the latest confirmed receipt that contains the product.
-- example: {"product":"Coca-Cola lon 320ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product)
SELECT r.supplier AS supplier
FROM purchase_lines pl
JOIN expenses e ON e.id = pl.expense_id
JOIN receipts r ON r.expense_id = e.id AND r.status = 'confirmed'
JOIN products p ON p.id = pl.product_id
JOIN ctx ON ctx.store_id = e.store_id AND p.name = ctx.product
WHERE e.category = 'nhap_hang' AND e.deleted_at IS NULL
ORDER BY e.spent_at DESC, e.id DESC
LIMIT 1
