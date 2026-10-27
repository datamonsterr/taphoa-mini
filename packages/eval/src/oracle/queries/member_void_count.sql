-- oracle: member_void_count
-- kind: count
-- args: member member, period period
-- uses: U8, U9, PERM
-- describe: Sales voided by a member in a period (by business date of the sale). Lead only.
-- example: {"member":"Anh Tư","period":"year_to_date"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::text AS member, $4::date AS period_from, $5::date AS period_to)
SELECT COUNT(*)::int AS void_count
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
JOIN members m ON m.id = s.voided_by AND m.display_name = ctx.member
WHERE s.status = 'voided'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
