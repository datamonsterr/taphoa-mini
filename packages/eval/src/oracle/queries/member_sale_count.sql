-- oracle: member_sale_count
-- kind: count
-- args: member member, period period
-- uses: U8, PERM
-- describe: Completed (not voided) sales rung up by a member in a period. Lead only.
-- example: {"member":"Bé Na","period":"last_30_days"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS member, $4::date AS period_from, $5::date AS period_to)
SELECT COUNT(*)::int AS sale_count
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
JOIN members m ON m.id = s.member_id AND m.display_name = ctx.member
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
