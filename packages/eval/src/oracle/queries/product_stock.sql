-- oracle: product_stock
-- kind: count
-- args: product product
-- uses: U11, U16
-- describe: Units in stock of a tracked product (base unit).
-- example: {"product":"Coca-Cola lon 320ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product)
SELECT p.stock_quantity AS stock
FROM products p
JOIN ctx ON ctx.store_id = p.store_id AND p.name = ctx.product
