-- oracle: dayclose_difference
-- kind: money
-- args: date date
-- uses: U5, PERM
-- describe: Cash difference recorded at the day close of a date (counted minus expected cash, negative means short), in dong. Fails when the date has no day close. Lead only.
-- example: {"date":"2026-10-14"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS day)
SELECT d.difference AS difference
FROM day_closes d
JOIN ctx ON ctx.store_id = d.store_id AND d.business_date = ctx.day
