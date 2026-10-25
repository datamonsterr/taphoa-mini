-- oracle: sales_product_units
-- kind: count
-- args: product product, period period
-- uses: U16, U18
-- describe: Units of a product sold in a period, counted in base units (a case counts as its size), over completed sales.
-- example: {"product":"Coca-Cola lon 320ml","period":"yesterday"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product, $4::date AS period_from, $5::date AS period_to)
SELECT COALESCE(SUM(l.quantity::bigint * l.quantity_in_base), 0)::int AS units
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
JOIN sale_lines l ON l.sale_id = s.id
JOIN products p ON p.id = l.product_id AND p.name = ctx.product
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
