-- oracle: stock_restock_names
-- kind: names
-- uses: U1, U13
-- describe: Every tracked product at or below its low-stock threshold, including out-of-stock and negative ones, furthest below its threshold first. Name set only, never quantities.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
JOIN stores st ON st.id = p.store_id
WHERE NOT p.archived
  AND p.stock_quantity <= COALESCE(p.low_stock_threshold, st.low_stock_threshold)
ORDER BY p.stock_quantity - COALESCE(p.low_stock_threshold, st.low_stock_threshold), p.name COLLATE "C"
