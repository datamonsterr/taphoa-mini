-- Reports need voided rows as well as the existing completed-sales partial index.
CREATE INDEX sales_voided_store_date ON sales (store_id, business_date, payment_method)
    WHERE status = 'voided';
