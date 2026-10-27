-- oracle: stock_restock_by_supplier_names
-- kind: names
-- args: supplier supplier
-- uses: U1, U13
-- describe: Restock products (stock at or below threshold) whose latest receipt came from the given supplier.
-- example: {"supplier":"Công ty Minh Phát"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS supplier),
last_purchase AS (
  SELECT DISTINCT ON (pl.product_id)
         pl.product_id,
         r.supplier AS supplier
  FROM purchase_lines pl
  JOIN expenses e ON e.id = pl.expense_id
  JOIN receipts r ON r.expense_id = e.id AND r.status = 'confirmed'
  JOIN ctx ON ctx.store_id = e.store_id
  WHERE e.category = 'nhap_hang' AND e.deleted_at IS NULL
  ORDER BY pl.product_id, e.spent_at DESC, e.id DESC
)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
JOIN stores st ON st.id = p.store_id
JOIN last_purchase lp ON lp.product_id = p.id AND lp.supplier = ctx.supplier
WHERE NOT p.archived
  AND p.stock_quantity <= COALESCE(p.low_stock_threshold, st.low_stock_threshold)
ORDER BY p.stock_quantity - COALESCE(p.low_stock_threshold, st.low_stock_threshold), p.name COLLATE "C"
