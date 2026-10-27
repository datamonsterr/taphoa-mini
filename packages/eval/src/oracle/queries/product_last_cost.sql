-- oracle: product_last_cost
-- kind: money
-- args: product product
-- uses: U1, U3, U17, PERM
-- describe: Latest cost of a product per base unit (its cost_price, which is the cost on the latest receipt), in dong. Lead only.
-- example: {"product":"Coca-Cola lon 320ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product)
SELECT p.cost_price AS cost
FROM products p
JOIN ctx ON ctx.store_id = p.store_id AND p.name = ctx.product
