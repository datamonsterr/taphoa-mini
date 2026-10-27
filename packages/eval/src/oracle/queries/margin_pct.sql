-- oracle: margin_pct
-- kind: percent
-- args: product product
-- uses: U3, PERM
-- describe: Margin of a product in percent of the retail price, one decimal: (price - latest cost) / price. Lead only.
-- example: {"product":"Nước suối Lavie 500ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product)
SELECT ROUND((p.price - p.cost_price) * 100.0 / NULLIF(p.price, 0), 1) AS margin_pct
FROM products p
JOIN ctx ON ctx.store_id = p.store_id AND p.name = ctx.product
