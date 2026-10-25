-- oracle: stock_low_names
-- kind: names
-- uses: U1, U13, U20
-- describe: Tracked products with stock above 0 and at or below their low-stock threshold (the store default when a product has none), fewest units left first.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
JOIN stores st ON st.id = p.store_id
WHERE NOT p.archived
  AND p.stock_quantity > 0
  AND p.stock_quantity <= COALESCE(p.low_stock_threshold, st.low_stock_threshold)
ORDER BY p.stock_quantity, p.name COLLATE "C"
