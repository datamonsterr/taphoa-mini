-- oracle: sales_category_units
-- kind: count
-- args: category category, period period
-- uses: U16, U18
-- describe: Units sold in base units across all products of a category in a period, over completed sales.
-- example: {"category":"Bia và rượu","period":"last_7_days"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS category, $4::date AS period_from, $5::date AS period_to)
SELECT COALESCE(SUM(l.quantity::bigint * l.quantity_in_base), 0)::int AS units
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
JOIN sale_lines l ON l.sale_id = s.id
JOIN products p ON p.id = l.product_id
JOIN categories c ON c.id = p.category_id AND c.name = ctx.category
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
