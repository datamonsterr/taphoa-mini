-- oracle: review_manual_candidate_names
-- kind: names
-- args: label text
-- uses: U6
-- describe: Every catalog product a reasonable reader accepts for an open manual line: the likely one first, then the lookalike the seed makes ambiguous on purpose (có đường or không đường, Simply or Neptune). Fixture input from STORE.md.
-- example: {"label":"dầu ăn chai"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS label),
likely(label, product_name, rank) AS (
  VALUES
    ('coca lon', 'Coca-Cola lon 320ml', 1),
    ('mì hảo hảo', 'Mì Hảo Hảo tôm chua cay 75g', 1),
    ('trứng gà lẻ', 'Trứng gà ta', 1),
    ('bia 333', 'Bia 333 lon 330ml', 1),
    ('nước lavie nhỏ', 'Nước suối Lavie 500ml', 1),
    ('sữa vinamilk đường', 'Sữa Vinamilk có đường 180ml', 1),
    ('sữa vinamilk đường', 'Sữa Vinamilk không đường 180ml', 2),
    ('kẹo alpen', 'Kẹo Alpenliebe caramen gói 120g', 1),
    ('dầu ăn chai', 'Dầu ăn Simply 1L', 1),
    ('dầu ăn chai', 'Dầu ăn Neptune 1L', 2),
    ('sting đỏ', 'Nước tăng lực Sting dâu chai 330ml', 1)
)
SELECT p.name
FROM likely
JOIN ctx ON likely.label = ctx.label
JOIN products p ON p.store_id = ctx.store_id AND p.name = likely.product_name
WHERE EXISTS (
  SELECT 1
  FROM sale_lines l
  WHERE l.store_id = ctx.store_id
    AND l.source = 'manual'
    AND l.review_status = 'open'
    AND l.manual_label = likely.label
)
ORDER BY likely.rank, p.name COLLATE "C"
