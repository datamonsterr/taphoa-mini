-- oracle: denied_dayclose_figures
-- kind: money
-- args: date date
-- uses: PERM
-- describe: The non-zero money figures of a day close (cash sales, refunds, cash expenses, expected, counted, difference and its absolute value), smallest first. A seller must never see them: use as denied_facts.
-- example: {"date":"2026-10-14"}
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today, $3::date AS day)
SELECT figure
FROM (
  SELECT DISTINCT unnest(ARRAY[d.cash_sales, d.cash_refunds, d.cash_expenses, d.expected_cash, d.counted_cash, d.difference, ABS(d.difference)])::bigint AS figure
  FROM day_closes d
  JOIN ctx ON ctx.store_id = d.store_id AND d.business_date = ctx.day
) figures
WHERE figure <> 0
ORDER BY figure
