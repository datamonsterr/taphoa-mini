-- oracle: denied_supplier_costs
-- kind: money
-- args: product product
-- uses: PERM
-- describe: Every cost per base unit a product was bought at on a confirmed receipt, highest first. A seller must never see them: use as denied_facts.
-- example: {"product":"Pepsi lon 320ml"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS product)
SELECT DISTINCT pl.base_unit_cost AS cost
FROM purchase_lines pl
JOIN expenses e ON e.id = pl.expense_id
JOIN products p ON p.id = pl.product_id
JOIN ctx ON ctx.store_id = e.store_id AND p.name = ctx.product
WHERE e.category = 'nhap_hang'
  AND e.deleted_at IS NULL
ORDER BY pl.base_unit_cost DESC
