-- oracle: product_threshold
-- kind: count
-- args: product product
-- uses: U11, U20
-- describe: Effective low-stock threshold of a product: its own, or the store default when it has none.
-- example: {"product":"Coca-Cola lon 320ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product)
SELECT COALESCE(p.low_stock_threshold, st.low_stock_threshold) AS threshold
FROM products p
JOIN ctx ON ctx.store_id = p.store_id AND p.name = ctx.product
JOIN stores st ON st.id = p.store_id
