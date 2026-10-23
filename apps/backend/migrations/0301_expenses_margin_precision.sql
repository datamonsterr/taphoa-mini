-- BIGINT costs can produce margins outside NUMERIC(6,2), e.g. price=1, cost=10000.
-- Keep two decimal places while supporting the full VND integer range.
ALTER TABLE margin_alerts ALTER COLUMN margin_pct TYPE NUMERIC(24,2);
