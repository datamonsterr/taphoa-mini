-- oracle: dayclose_expected_cash
-- kind: money
-- args: date date
-- uses: U5
-- describe: Expected cash recorded at the day close of a date (opening float + cash sales - cash refunds - cash expenses), in dong. Fails when the date has no day close. Lead only.
-- example: {"date":"2026-10-14"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS day)
SELECT d.expected_cash AS expected_cash
FROM day_closes d
JOIN ctx ON ctx.store_id = d.store_id AND d.business_date = ctx.day
