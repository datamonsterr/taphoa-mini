-- oracle: catalog_few_refs_names
-- kind: names
-- uses: U7, U19
-- describe: Products with fewer than 3 reference photos, none included, fewest photos first.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
LEFT JOIN (
  SELECT product_id, COUNT(*) AS photos
  FROM product_images
  GROUP BY product_id
) refs ON refs.product_id = p.id
WHERE NOT p.archived
  AND COALESCE(refs.photos, 0) < 3
ORDER BY COALESCE(refs.photos, 0), p.name COLLATE "C"
