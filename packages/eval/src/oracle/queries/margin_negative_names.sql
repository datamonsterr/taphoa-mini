-- oracle: margin_negative_names
-- kind: names
-- uses: U3
-- describe: Products whose latest cost is above the retail price (negative margin), worst first.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
WHERE NOT p.archived
  AND p.cost_price IS NOT NULL
  AND p.price > 0
  AND p.cost_price > p.price
ORDER BY (p.price - p.cost_price) * 1.0 / p.price, p.name COLLATE "C"
