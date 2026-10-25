-- oracle: threshold_missing_names
-- kind: names
-- uses: U20, U21
-- describe: Tracked products without their own low-stock threshold (the store default applies), in name order.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
WHERE NOT p.archived
  AND p.stock_quantity IS NOT NULL
  AND p.low_stock_threshold IS NULL
ORDER BY p.name COLLATE "C"
