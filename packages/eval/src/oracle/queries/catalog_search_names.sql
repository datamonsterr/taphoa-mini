-- oracle: catalog_search_names
-- kind: names
-- args: query text
-- uses: U16
-- describe: Products whose name contains the text, ignoring case and diacritics, in name order.
-- example: {"query":"Coca"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS query)
SELECT p.name
FROM products p
JOIN ctx ON ctx.store_id = p.store_id
WHERE NOT p.archived
  AND strpos(immutable_unaccent(lower(p.name)), immutable_unaccent(lower(ctx.query))) > 0
ORDER BY p.name COLLATE "C"
