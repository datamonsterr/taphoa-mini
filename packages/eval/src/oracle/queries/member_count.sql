-- oracle: member_count
-- kind: count
-- uses: U21
-- describe: Number of active members of the store, the Lead included.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT COUNT(*)::int AS members
FROM members m
JOIN ctx ON ctx.store_id = m.store_id
WHERE m.active
