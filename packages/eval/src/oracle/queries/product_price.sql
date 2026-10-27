-- oracle: product_price
-- kind: money
-- args: product product
-- uses: U3, U11
-- describe: Current retail price of a product per base unit, in dong.
-- example: {"product":"Coca-Cola lon 320ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product)
SELECT p.price AS price
FROM products p
JOIN ctx ON ctx.store_id = p.store_id AND p.name = ctx.product
