-- oracle: denied_member_activity
-- kind: count
-- args: period period
-- uses: PERM
-- describe: Completed-sale count per member in a period, one number per member, Lead first. A seller must never see them: use as denied_facts.
-- example: {"period":"last_30_days"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS period_from, $4::date AS period_to)
SELECT COUNT(*)::int AS sale_count
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
JOIN members m ON m.id = s.member_id
WHERE s.status = 'completed'
  AND s.business_date BETWEEN ctx.period_from AND ctx.period_to
GROUP BY m.id, m.role, m.display_name
ORDER BY (m.role = 'lead') DESC, m.display_name COLLATE "C"
