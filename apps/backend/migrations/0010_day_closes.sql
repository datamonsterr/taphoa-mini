-- 3.7 Day close
CREATE TABLE day_closes (
    store_id         UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    business_date    DATE NOT NULL,
    opening_float    BIGINT NOT NULL DEFAULT 0,
    cash_sales       BIGINT NOT NULL,
    cash_refunds     BIGINT NOT NULL,
    cash_expenses    BIGINT NOT NULL,
    expected_cash    BIGINT NOT NULL,
    counted_cash     BIGINT NOT NULL CHECK (counted_cash >= 0),
    difference       BIGINT GENERATED ALWAYS AS (counted_cash - expected_cash) STORED,
    transfer_revenue BIGINT NOT NULL,
    note             TEXT,
    closed_by        UUID NOT NULL REFERENCES members,
    closed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (store_id, business_date)
);
