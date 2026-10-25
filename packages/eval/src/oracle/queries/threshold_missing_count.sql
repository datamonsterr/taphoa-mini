-- oracle: threshold_missing_count
-- kind: count
-- uses: U20, U21
-- describe: Number of tracked products without their own low-stock threshold.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT COUNT(*)::int AS missing
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
WHERE NOT p.archived
  AND p.stock_quantity IS NOT NULL
  AND p.low_stock_threshold IS NULL
