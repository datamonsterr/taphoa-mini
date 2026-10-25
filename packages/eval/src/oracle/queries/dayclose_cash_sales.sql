-- oracle: dayclose_cash_sales
-- kind: money
-- args: date date
-- uses: U5
-- describe: Cash sales of a business date as the day close counts them: every sale paid in cash, including the ones voided later (refunds are separate), in dong. Lead only.
-- example: {"date":"2026-10-14"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS day)
SELECT COALESCE(SUM(s.total), 0)::bigint AS cash_sales
FROM sales s
JOIN ctx ON ctx.store_id = s.store_id
WHERE s.payment_method = 'cash'
  AND s.business_date = ctx.day
