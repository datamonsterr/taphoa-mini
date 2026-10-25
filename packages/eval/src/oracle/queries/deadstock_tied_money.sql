-- oracle: deadstock_tied_money
-- kind: money
-- args: days int
-- uses: U4
-- describe: Money tied up in dead stock in dong: the sum of stock x current cost over the dead-stock products. Lead only.
-- example: {"days":30}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::int AS days)
SELECT COALESCE(SUM(p.stock_quantity::bigint * COALESCE(p.cost_price, 0)), 0)::bigint AS tied_money
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
