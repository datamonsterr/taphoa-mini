-- oracle: catalog_duplicate_pair_names
-- kind: names
-- uses: U19
-- describe: Names of possible duplicate products: same category and price and a name similarity of 0.85 or more (pg_trgm, ignoring case and diacritics), both names of each pair, closest pair first.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today),
pairs AS (
  SELECT a.name AS name_a,
         b.name AS name_b,
         similarity(immutable_unaccent(lower(a.name)), immutable_unaccent(lower(b.name))) AS sim
  FROM products a
  JOIN ctx ON ctx.store_id = a.store_id
  JOIN products b ON b.store_id = a.store_id AND a.id < b.id
  WHERE NOT a.archived
    AND NOT b.archived
    AND a.category_id IS NOT NULL
    AND a.category_id = b.category_id
    AND a.price = b.price
)
SELECT n.name
FROM pairs
CROSS JOIN LATERAL (VALUES (pairs.name_a, 1), (pairs.name_b, 2)) AS n(name, side)
WHERE pairs.sim >= 0.85
ORDER BY pairs.sim DESC, pairs.name_a COLLATE "C", n.side
