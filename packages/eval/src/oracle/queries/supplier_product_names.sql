-- oracle: supplier_product_names
-- kind: names
-- args: product product
-- uses: U17
-- describe: Suppliers that sold a product on a confirmed receipt, most recent purchase first. Lead only.
-- example: {"product":"Pepsi lon 320ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product),
suppliers AS (
  SELECT r.supplier AS supplier,
         MAX(e.spent_at) AS last_at
  FROM purchase_lines pl
  JOIN expenses e ON e.id = pl.expense_id
  JOIN receipts r ON r.expense_id = e.id AND r.status = 'confirmed'
  JOIN products p ON p.id = pl.product_id
  JOIN ctx ON ctx.store_id = e.store_id AND p.name = ctx.product
  WHERE e.category = 'nhap_hang'
    AND e.deleted_at IS NULL
  GROUP BY 1
)
SELECT supplier
FROM suppliers
ORDER BY last_at DESC, supplier COLLATE "C"
