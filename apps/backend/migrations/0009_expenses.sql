-- 3.6 Expenses, purchases, alerts
CREATE TABLE expenses (
    id            UUID PRIMARY KEY,
    store_id      UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    member_id     UUID NOT NULL REFERENCES members,
    spent_at      TIMESTAMPTZ NOT NULL,
    business_date DATE NOT NULL,
    amount        BIGINT NOT NULL CHECK (amount > 0),
    category      TEXT NOT NULL CHECK (category IN ('nhap_hang', 'dien', 'nuoc', 'khac')),
    paid_with     TEXT NOT NULL CHECK (paid_with IN ('cash_box', 'other')),
    image_id      UUID REFERENCES images,
    note          TEXT CHECK (char_length(note) <= 500),
    deleted_at    TIMESTAMPTZ,
    request_hash  BYTEA NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX expenses_store_date ON expenses (store_id, business_date) WHERE deleted_at IS NULL;

CREATE TABLE purchase_lines (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id       UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    expense_id     UUID NOT NULL REFERENCES expenses ON DELETE CASCADE,
    product_id     UUID NOT NULL REFERENCES products,
    unit_id        UUID REFERENCES product_units,
    quantity       INT NOT NULL CHECK (quantity > 0),
    unit_cost      BIGINT NOT NULL CHECK (unit_cost >= 0),
    base_unit_cost BIGINT NOT NULL CHECK (base_unit_cost >= 0)  -- unit_cost / quantity_in_base, rounded up
);

CREATE TABLE margin_alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id        UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES products ON DELETE CASCADE,
    expense_id      UUID REFERENCES expenses ON DELETE SET NULL,
    cost_price      BIGINT NOT NULL,
    selling_price   BIGINT NOT NULL,
    margin_pct      NUMERIC(6,2) NOT NULL,
    suggested_price BIGINT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed')),
    resolved_by     UUID REFERENCES members,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One open alert per product; a newer purchase updates the open alert instead.
CREATE UNIQUE INDEX margin_alerts_open ON margin_alerts (product_id) WHERE status = 'open';
-- Handler index: store_id first.
CREATE INDEX margin_alerts_store ON margin_alerts (store_id, status);
