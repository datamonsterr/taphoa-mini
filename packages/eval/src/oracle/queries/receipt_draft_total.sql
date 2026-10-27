-- oracle: receipt_draft_total
-- kind: money
-- uses: U14
-- describe: Total of the draft receipt in dong (the sum of its line amounts).
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT r.total AS total
FROM receipts r
JOIN ctx ON ctx.store_id = r.store_id
WHERE r.status = 'draft'
ORDER BY r.created_at DESC, r.id
LIMIT 1
