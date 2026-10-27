-- oracle: supplier_product_latest_cost
-- kind: money
-- args: product product, supplier supplier
-- uses: U17
-- describe: Cost per base unit of a product on the latest receipt from a given supplier, in dong. Lead only.
-- example: {"product":"Pepsi lon 320ml","supplier":"Công ty Minh Phát"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product, $4::text AS supplier)
SELECT pl.base_unit_cost AS cost
FROM purchase_lines pl
JOIN expenses e ON e.id = pl.expense_id
JOIN receipts r ON r.expense_id = e.id AND r.status = 'confirmed'
JOIN products p ON p.id = pl.product_id
JOIN ctx ON ctx.store_id = e.store_id AND p.name = ctx.product
WHERE e.category = 'nhap_hang'
  AND e.deleted_at IS NULL
  AND r.supplier = ctx.supplier
ORDER BY e.spent_at DESC, e.id DESC
LIMIT 1
