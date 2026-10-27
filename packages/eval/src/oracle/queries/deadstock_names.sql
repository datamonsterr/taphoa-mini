-- oracle: deadstock_names
-- kind: names
-- args: days int
-- uses: U4
-- describe: Tracked products with stock above 0 and no completed sale in the last N days (today included), most money tied up first.
-- example: {"days":30}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::int AS days)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
WHERE NOT p.archived
  AND p.stock_quantity > 0
  AND NOT EXISTS (
    SELECT 1
    FROM sale_lines l
    JOIN sales s ON s.id = l.sale_id
    WHERE l.product_id = p.id
      AND s.status = 'completed'
      AND s.business_date > ctx.today - ctx.days
  )
ORDER BY p.stock_quantity::bigint * COALESCE(p.cost_price, 0) DESC, p.name COLLATE "C"
