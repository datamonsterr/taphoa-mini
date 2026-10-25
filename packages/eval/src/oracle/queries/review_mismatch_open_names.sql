-- oracle: review_mismatch_open_names
-- kind: names
-- uses: U6
-- describe: Products on the open price-mismatch lines (sold below the catalog price), oldest first.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT p.name
FROM sale_lines l
JOIN ctx ON ctx.store_id = l.store_id
JOIN sales s ON s.id = l.sale_id
JOIN products p ON p.id = l.product_id
WHERE l.review_reason = 'price_mismatch'
  AND l.review_status = 'open'
ORDER BY s.sold_at, l.position
