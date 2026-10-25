-- oracle: supplier_cheapest_cost
-- kind: money
-- args: product product
-- uses: U17
-- describe: The lowest cost per base unit among the suppliers' latest receipts of a product, in dong. Lead only.
-- example: {"product":"Pepsi lon 320ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product),
latest AS (
  SELECT DISTINCT ON (regexp_replace(e.note, '^Nhập hàng: ', ''))
         pl.base_unit_cost AS cost
  FROM purchase_lines pl
  JOIN expenses e ON e.id = pl.expense_id
  JOIN products p ON p.id = pl.product_id
  JOIN ctx ON ctx.store_id = e.store_id AND p.name = ctx.product
  WHERE e.category = 'nhap_hang'
    AND e.deleted_at IS NULL
  ORDER BY regexp_replace(e.note, '^Nhập hàng: ', ''), e.spent_at DESC, e.id DESC
)
SELECT MIN(cost) AS cheapest_cost
FROM latest
