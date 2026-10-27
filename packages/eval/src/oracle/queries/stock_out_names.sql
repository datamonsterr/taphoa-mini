-- oracle: stock_out_names
-- kind: names
-- uses: U1, U13
-- describe: Tracked products with exactly 0 in stock.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
WHERE NOT p.archived
  AND p.stock_quantity = 0
ORDER BY p.name COLLATE "C"
