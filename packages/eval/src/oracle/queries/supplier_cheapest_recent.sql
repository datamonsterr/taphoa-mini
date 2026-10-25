-- oracle: supplier_cheapest_recent
-- kind: names
-- args: product product
-- uses: U17
-- describe: The supplier with the lowest cost on its latest receipt of a product (ties go to the more recent receipt). Not always the last supplier used. Lead only.
-- example: {"product":"Pepsi lon 320ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product),
latest AS (
  SELECT DISTINCT ON (regexp_replace(e.note, '^Nhập hàng: ', ''))
         regexp_replace(e.note, '^Nhập hàng: ', '') AS supplier,
         pl.base_unit_cost AS cost,
         e.spent_at
  FROM purchase_lines pl
  JOIN expenses e ON e.id = pl.expense_id
  JOIN products p ON p.id = pl.product_id
  JOIN ctx ON ctx.store_id = e.store_id AND p.name = ctx.product
  WHERE e.category = 'nhap_hang'
    AND e.deleted_at IS NULL
  ORDER BY regexp_replace(e.note, '^Nhập hàng: ', ''), e.spent_at DESC, e.id DESC
)
SELECT supplier
FROM latest
ORDER BY cost, spent_at DESC, supplier COLLATE "C"
LIMIT 1
