-- oracle: member_manual_line_count
-- kind: count
-- args: member member, period period
-- uses: U8, PERM
-- describe: Manual lines (typed labels instead of a recognised product) in the completed sales of a member in a period. Lead only.
-- example: {"member":"Bé Na","period":"year_to_date"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS member, $4::date AS period_from, $5::date AS period_to)
SELECT COUNT(*)::int AS manual_lines
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
JOIN members m ON m.id = s.member_id AND m.display_name = ctx.member
JOIN sale_lines l ON l.sale_id = s.id
WHERE s.status = 'completed'
  AND l.source = 'manual'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
