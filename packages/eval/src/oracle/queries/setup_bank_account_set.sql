-- oracle: setup_bank_account_set
-- kind: count
-- uses: U21
-- describe: 1 when the VietQR bank account of the store is set, 0 when it is not.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT CASE WHEN st.bank_bin IS NOT NULL AND st.bank_account_number IS NOT NULL THEN 1 ELSE 0 END AS bank_set
FROM stores st
JOIN ctx ON ctx.store_id = st.id
