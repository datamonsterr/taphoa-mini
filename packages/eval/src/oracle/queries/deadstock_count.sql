-- oracle: deadstock_count
-- kind: count
-- args: days int
-- uses: U4
-- describe: Number of dead-stock products (tracked, stock above 0, no completed sale in the last N days).
-- example: {"days":30}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::int AS days)
SELECT COUNT(*)::int AS dead_count
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
