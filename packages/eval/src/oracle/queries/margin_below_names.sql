-- oracle: margin_below_names
-- kind: names
-- args: below_pct int
-- uses: U3
-- describe: Every product with a margin under the given percent, negative ones included (the set get_margin_report returns for min_margin_pct), thinnest first.
-- example: {"below_pct":10}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::int AS below_pct)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
WHERE NOT p.archived
  AND p.cost_price IS NOT NULL
  AND p.price > 0
  AND (p.price - p.cost_price) * 100.0 / p.price < ctx.below_pct
ORDER BY (p.price - p.cost_price) * 1.0 / p.price, p.name COLLATE "C"
