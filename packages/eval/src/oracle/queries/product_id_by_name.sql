-- oracle: product_id_by_name
-- kind: names
-- args: product product
-- uses: U11
-- describe: The product id (uuid text) of a product, for action fields such as product_id.
-- example: {"product":"Coca-Cola lon 320ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product)
SELECT p.id::text AS product_id
FROM products p
JOIN ctx ON ctx.store_id = p.store_id AND p.name = ctx.product
