-- oracle: anomaly_price_jump_names
-- kind: names
-- args: min_pct int
-- uses: U9
-- describe: Products with a single retail price change of at least the given percent, up or down, biggest first. Lead only.
-- example: {"min_pct":25}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::int AS min_pct)
SELECT p.name
FROM price_history h
JOIN ctx ON ctx.store_id = h.store_id
JOIN products p ON p.id = h.product_id
WHERE h.field = 'price'
  AND h.old_value > 0
  AND ABS(h.new_value - h.old_value) * 100.0 / h.old_value >= ctx.min_pct
GROUP BY p.id, p.name
ORDER BY MAX(ABS(h.new_value - h.old_value) * 100.0 / h.old_value) DESC, p.name COLLATE "C"
