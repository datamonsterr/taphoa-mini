-- oracle: stock_negative_names
-- kind: names
-- uses: U1, U9
-- describe: Tracked products whose stock is below 0 (sold more than the last count), most negative first.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
WHERE NOT p.archived
  AND p.stock_quantity < 0
ORDER BY p.stock_quantity, p.name COLLATE "C"
