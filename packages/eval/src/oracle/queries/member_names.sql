-- oracle: member_names
-- kind: names
-- uses: U8, U21
-- describe: Display names of the active members, Lead first.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT m.display_name
FROM members m
JOIN ctx ON ctx.store_id = m.store_id
WHERE m.active
ORDER BY (m.role = 'lead') DESC, m.display_name COLLATE "C"
