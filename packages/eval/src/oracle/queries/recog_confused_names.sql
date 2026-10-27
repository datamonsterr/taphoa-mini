-- oracle: recog_confused_names
-- kind: names
-- uses: U7
-- describe: Products the seller sold although the camera suggested a different product, over the whole history: at least 5 detections and 25 percent or more of them with another suggestion, worst first. Lead only.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today),
stats AS (
  SELECT l.product_id,
         COUNT(*) AS detections,
         COUNT(*) FILTER (WHERE l.suggested_product_id IS NOT NULL AND l.suggested_product_id <> l.product_id) AS confused
  FROM sales s
  JOIN ctx ON ctx.store_id = s.store_id
  JOIN sale_lines l ON l.sale_id = s.id
  JOIN detections d ON d.id = l.detection_id
  GROUP BY l.product_id
)
SELECT p.name
FROM stats
JOIN products p ON p.id = stats.product_id
WHERE stats.detections >= 5
  AND stats.confused * 4 >= stats.detections
ORDER BY stats.confused::numeric / stats.detections DESC, p.name COLLATE "C"
