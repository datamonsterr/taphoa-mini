-- oracle: recog_confused_with_names
-- kind: names
-- uses: U7
-- describe: For each often-confused product (recog_confused_names), the product the camera suggested most often instead, most frequent first. Lead only.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today),
linked AS (
  SELECT l.product_id, l.suggested_product_id
  FROM sales s
  JOIN ctx ON ctx.store_id = s.store_id
  JOIN sale_lines l ON l.sale_id = s.id
  JOIN detections d ON d.id = l.detection_id
),
stats AS (
  SELECT product_id,
         COUNT(*) AS detections,
         COUNT(*) FILTER (WHERE suggested_product_id IS NOT NULL AND suggested_product_id <> product_id) AS confused
  FROM linked
  GROUP BY product_id
),
pairs AS (
  SELECT l.product_id, l.suggested_product_id, COUNT(*) AS n
  FROM linked l
  JOIN stats ON stats.product_id = l.product_id
  WHERE stats.detections >= 5
    AND stats.confused * 4 >= stats.detections
    AND l.suggested_product_id IS NOT NULL
    AND l.suggested_product_id <> l.product_id
  GROUP BY l.product_id, l.suggested_product_id
),
top_pair AS (
  SELECT DISTINCT ON (product_id) product_id, suggested_product_id, n
  FROM pairs
  ORDER BY product_id, n DESC, suggested_product_id
)
SELECT p.name
FROM top_pair
JOIN products p ON p.id = top_pair.suggested_product_id
ORDER BY top_pair.n DESC, p.name COLLATE "C"
