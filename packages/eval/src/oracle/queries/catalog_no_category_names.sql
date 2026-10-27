-- oracle: catalog_no_category_names
-- kind: names
-- uses: U19
-- describe: Products with no category, in name order.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
WHERE NOT p.archived
  AND p.category_id IS NULL
ORDER BY p.name COLLATE "C"
