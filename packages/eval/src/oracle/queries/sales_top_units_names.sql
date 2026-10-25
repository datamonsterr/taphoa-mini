-- oracle: sales_top_units_names
-- kind: names
-- args: period period, limit int
-- uses: U2, U13, U18, U20
-- describe: The top N products by units sold (base units) in a period, best first, over completed sales. Pick N so there is no tie at the cut.
-- example: {"period":"last_14_days","limit":5}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to, $5::int AS row_limit)
SELECT p.name
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
JOIN sale_lines l ON l.sale_id = s.id
JOIN products p ON p.id = l.product_id
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
GROUP BY p.id, p.name
ORDER BY SUM(l.quantity::bigint * l.quantity_in_base) DESC, p.name COLLATE "C"
LIMIT (SELECT row_limit FROM ctx)
