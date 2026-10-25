-- oracle: member_most_voids_name
-- kind: names
-- args: period period
-- uses: U8, U9
-- describe: The member who voided the most sales in a period. Lead only.
-- example: {"period":"year_to_date"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
SELECT m.display_name
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
JOIN members m ON m.id = s.voided_by
WHERE s.status = 'voided'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
GROUP BY m.id, m.display_name
ORDER BY COUNT(*) DESC, m.display_name COLLATE "C"
LIMIT 1
