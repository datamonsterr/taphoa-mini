-- oracle: review_manual_match_name
-- kind: names
-- args: label text
-- uses: U6
-- describe: The catalog product an open manual line most likely means. The label to product mapping is a fixture input from STORE.md, checked against the catalog and the open queue.
-- example: {"label":"coca lon"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS label),
likely(label, product_name) AS (
  VALUES
    ('coca lon', 'Coca-Cola lon 320ml'),
    ('mì hảo hảo', 'Mì Hảo Hảo tôm chua cay 75g'),
    ('trứng gà lẻ', 'Trứng gà ta'),
    ('bia 333', 'Bia 333 lon 330ml'),
    ('nước lavie nhỏ', 'Nước suối Lavie 500ml'),
    ('sữa vinamilk đường', 'Sữa Vinamilk có đường 180ml'),
    ('kẹo alpen', 'Kẹo Alpenliebe caramen gói 120g'),
    ('dầu ăn chai', 'Dầu ăn Simply 1L'),
    ('sting đỏ', 'Nước tăng lực Sting dâu chai 330ml')
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
