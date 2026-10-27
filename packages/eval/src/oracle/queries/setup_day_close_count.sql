-- oracle: setup_day_close_count
-- kind: count
-- uses: U21
-- describe: Number of day closes (chot so) the store has recorded.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT COUNT(*)::int AS day_closes
FROM day_closes d
JOIN ctx ON ctx.store_id = d.store_id
