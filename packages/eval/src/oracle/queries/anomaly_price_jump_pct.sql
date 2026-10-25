-- oracle: anomaly_price_jump_pct
-- kind: percent
-- args: product product
-- uses: U9
-- describe: Percent change of the latest retail price change of a product, one decimal (positive means the price went up). Lead only.
-- example: {"product":"Đường cát trắng Biên Hòa 1kg"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product)
SELECT ROUND((h.new_value - h.old_value) * 100.0 / h.old_value, 1) AS change_pct
FROM price_history h
JOIN ctx ON ctx.store_id = h.store_id
JOIN products p ON p.id = h.product_id AND p.name = ctx.product
WHERE h.field = 'price'
  AND h.old_value > 0
ORDER BY h.changed_at DESC
LIMIT 1
