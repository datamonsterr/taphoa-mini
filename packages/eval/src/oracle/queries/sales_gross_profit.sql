-- oracle: sales_gross_profit
-- kind: money
-- args: period period
-- uses: U2, U13, PERM
-- describe: Gross profit of completed sales in a period in dong: line revenue minus units x current product cost, over lines that have a product (the same formula as the reports endpoint). Lead only.
-- example: {"period":"yesterday"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
SELECT COALESCE(SUM(l.line_total - l.quantity::bigint * l.quantity_in_base * COALESCE(p.cost_price, 0)), 0)::bigint AS gross_profit
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
JOIN sale_lines l ON l.sale_id = s.id
JOIN products p ON p.id = l.product_id
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
