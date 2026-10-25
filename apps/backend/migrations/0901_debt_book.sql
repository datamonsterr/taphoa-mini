-- X5 debt book. Amounts are signed VND; the customer row serializes ledger writers.
CREATE TABLE customers (
    id UUID PRIMARY KEY,
    store_id UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    phone TEXT CHECK (char_length(phone) <= 20),
    note TEXT CHECK (char_length(note) <= 200),
    credit_limit BIGINT CHECK (credit_limit >= 0),
    balance BIGINT NOT NULL DEFAULT 0,
    oldest_debt_date DATE,
    archived_at TIMESTAMPTZ,
    request_hash BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (store_id, id)
);
CREATE INDEX customers_store_name ON customers (store_id, lower(name));
CREATE INDEX customers_store_oldest_debt ON customers (store_id, oldest_debt_date) WHERE balance > 0;

CREATE TABLE debt_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    customer_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('credit_sale', 'repayment', 'adjustment', 'void')),
    amount BIGINT NOT NULL,
    balance_after BIGINT NOT NULL,
    sale_id UUID REFERENCES sales,
    method TEXT CHECK (method IN ('cash', 'transfer')),
    reason TEXT CHECK (char_length(reason) BETWEEN 1 AND 200),
    member_id UUID NOT NULL REFERENCES members,
    business_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    key_hash BYTEA,
    request_hash BYTEA,
    FOREIGN KEY (store_id, customer_id) REFERENCES customers (store_id, id) ON DELETE CASCADE,
    CHECK ((kind = 'credit_sale' AND amount > 0)
        OR (kind IN ('void', 'repayment') AND amount < 0)
        OR (kind = 'adjustment' AND amount <> 0))
);
CREATE INDEX debt_entries_store_customer_created ON debt_entries (store_id, customer_id, created_at);
CREATE UNIQUE INDEX debt_entries_store_key ON debt_entries (store_id, key_hash) WHERE key_hash IS NOT NULL;

ALTER TABLE sales DROP CONSTRAINT sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check CHECK (payment_method IN ('cash', 'transfer', 'credit'));
ALTER TABLE sales ADD COLUMN customer_id UUID REFERENCES customers;
ALTER TABLE sales ADD COLUMN credit_amount BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sales ADD CONSTRAINT sales_credit_amount_check CHECK (credit_amount >= 0 AND credit_amount <= total);
ALTER TABLE sales ADD CONSTRAINT sales_credit_customer_check CHECK ((credit_amount > 0) = (customer_id IS NOT NULL));
ALTER TABLE sales ADD CONSTRAINT sales_credit_method_check CHECK (payment_method <> 'credit' OR credit_amount = total);
-- 0008's second unnamed table CHECK is sales_check1 (verified via pg_constraint).
ALTER TABLE sales DROP CONSTRAINT sales_check1;
ALTER TABLE sales ADD CONSTRAINT sales_check1 CHECK (cash_received IS NULL OR cash_received >= total - credit_amount);

ALTER TABLE day_closes ADD COLUMN cash_repayments BIGINT NOT NULL DEFAULT 0;
ALTER TABLE day_closes ADD COLUMN transfer_repayments BIGINT NOT NULL DEFAULT 0;
ALTER TABLE day_closes ADD COLUMN credit_sales BIGINT NOT NULL DEFAULT 0;

ALTER TABLE change_log DROP CONSTRAINT change_log_entity_check;
ALTER TABLE change_log ADD CONSTRAINT change_log_entity_check CHECK (entity IN ('store', 'member', 'category', 'product', 'customer', 'debt_entry'));
