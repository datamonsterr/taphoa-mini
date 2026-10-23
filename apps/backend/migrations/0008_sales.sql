-- 3.5 Sales
CREATE TABLE sales (
    id             UUID PRIMARY KEY,                        -- client UUIDv7
    store_id       UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    code           TEXT NOT NULL,                           -- 6 chars Crockford base32 from id
    member_id      UUID NOT NULL REFERENCES members,
    session_id     UUID REFERENCES sessions ON DELETE SET NULL,
    sold_at        TIMESTAMPTZ NOT NULL,                    -- device time
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),      -- server time
    business_date  DATE NOT NULL,
    payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'transfer')),
    cash_received  BIGINT CHECK (cash_received >= 0),
    total          BIGINT NOT NULL CHECK (total >= 0),
    vietqr_memo    TEXT,
    status         TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
    void_reason    TEXT,
    voided_by      UUID REFERENCES members,
    voided_at      TIMESTAMPTZ,
    request_hash   BYTEA NOT NULL,
    CHECK (payment_method = 'cash' OR cash_received IS NULL),
    CHECK (cash_received IS NULL OR cash_received >= total),
    CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
    UNIQUE (store_id, code)
);
CREATE INDEX sales_store_date ON sales (store_id, business_date, payment_method) WHERE status = 'completed';
CREATE INDEX sales_store_sold ON sales (store_id, sold_at DESC);

CREATE TABLE sale_lines (
    id                   UUID PRIMARY KEY,
    store_id             UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    sale_id              UUID NOT NULL REFERENCES sales ON DELETE CASCADE,
    position             SMALLINT NOT NULL,
    product_id           UUID REFERENCES products,
    unit_id              UUID REFERENCES product_units,
    source               TEXT NOT NULL CHECK (source IN ('camera', 'multi_photo', 'barcode', 'grid', 'manual')),
    quantity             INT NOT NULL CHECK (quantity BETWEEN 1 AND 999),
    unit_price           BIGINT NOT NULL CHECK (unit_price >= 0),
    line_total           BIGINT GENERATED ALWAYS AS (quantity * unit_price) STORED,
    quantity_in_base     INT NOT NULL DEFAULT 1,            -- snapshot of unit size for reports
    manual_label         TEXT,
    detection_id         UUID UNIQUE REFERENCES detections ON DELETE SET NULL,
    suggested_product_id UUID,
    price_mismatch       BOOLEAN NOT NULL DEFAULT false,
    review_status        TEXT CHECK (review_status IN ('open', 'resolved')),
    review_reason        TEXT CHECK (review_reason IN ('manual_price', 'price_mismatch')),
    review_action        TEXT CHECK (review_action IN ('link', 'enrolled', 'dismiss')),
    review_product_id    UUID REFERENCES products,
    reviewed_by          UUID REFERENCES members,
    reviewed_at          TIMESTAMPTZ,
    -- Only manual lines may lack a product; resolving a manual line sets review_product_id, not product_id.
    CHECK (source = 'manual' OR product_id IS NOT NULL),
    UNIQUE (sale_id, position)
);
CREATE INDEX sale_lines_review ON sale_lines (store_id, review_status) WHERE review_status = 'open';
CREATE INDEX sale_lines_product ON sale_lines (store_id, product_id);

CREATE TABLE sale_scans (
    sale_id UUID NOT NULL REFERENCES sales ON DELETE CASCADE,
    scan_id UUID NOT NULL REFERENCES scans ON DELETE CASCADE,
    PRIMARY KEY (sale_id, scan_id)
);
