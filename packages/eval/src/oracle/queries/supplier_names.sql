-- oracle: supplier_names
-- kind: names
-- uses: U17
-- describe: Suppliers the store bought from (from confirmed receipts), most recent purchase first.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today),
suppliers AS (
  SELECT regexp_replace(e.note, '^Nhập hàng: ', '') AS supplier,
         MAX(e.spent_at) AS last_at
  FROM expenses e
  JOIN ctx ON ctx.store_id = e.store_id
  WHERE e.category = 'nhap_hang'
    AND e.deleted_at IS NULL
  GROUP BY 1
)
SELECT supplier
FROM suppliers
ORDER BY last_at DESC, supplier COLLATE "C"
