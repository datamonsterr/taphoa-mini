-- oracle: catalog_no_photo_names
-- kind: names
-- uses: U19
-- describe: Products with no reference photo at all, in name order.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
WHERE NOT p.archived
  AND NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id)
ORDER BY p.name COLLATE "C"
