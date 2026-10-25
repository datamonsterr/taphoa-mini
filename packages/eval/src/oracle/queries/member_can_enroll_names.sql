-- oracle: member_can_enroll_names
-- kind: names
-- uses: U14, U21
-- describe: Active members allowed to enroll products and confirm receipts.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT m.display_name
FROM members m
JOIN ctx ON ctx.store_id = m.store_id
WHERE m.active AND m.can_enroll
ORDER BY (m.role = 'lead') DESC, m.display_name COLLATE "C"
