ALTER TABLE stores ADD COLUMN low_stock_threshold INT NOT NULL DEFAULT 5
    CHECK (low_stock_threshold BETWEEN 0 AND 100000);
ALTER TABLE products
    ADD COLUMN stock_quantity INT,
    ADD COLUMN low_stock_threshold INT CHECK (low_stock_threshold BETWEEN 0 AND 100000);

CREATE TABLE stock_movements (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id       UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    product_id     UUID NOT NULL REFERENCES products ON DELETE CASCADE,
    delta          INT NOT NULL,
    quantity_after INT NOT NULL,
    reason         TEXT NOT NULL CHECK (reason IN ('receipt', 'sale', 'sale_void', 'adjustment')),
    ref_id         UUID,
    member_id      UUID REFERENCES members,
    note           TEXT CHECK (char_length(note) <= 200),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product ON stock_movements (store_id, product_id, created_at DESC);

CREATE TABLE receipts (
    id           UUID PRIMARY KEY,
    store_id     UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    member_id    UUID NOT NULL REFERENCES members,
    image_id     UUID NOT NULL REFERENCES images,
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'discarded')),
    ocr_text     TEXT NOT NULL,
    parser       TEXT NOT NULL CHECK (parser IN ('decisions', 'fallback')),
    model        TEXT,
    timings      JSONB NOT NULL DEFAULT '{}',
    total        BIGINT NOT NULL DEFAULT 0,
    expense_id   UUID REFERENCES expenses ON DELETE SET NULL,
    request_hash BYTEA NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX receipts_store_created ON receipts (store_id, created_at DESC);

CREATE TABLE receipt_lines (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id       UUID NOT NULL REFERENCES receipts ON DELETE CASCADE,
    store_id         UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    position         INT NOT NULL,
    raw_text         TEXT NOT NULL,
    product_name     TEXT NOT NULL,
    quantity         INT NOT NULL CHECK (quantity > 0),
    cost             BIGINT NOT NULL CHECK (cost >= 0),
    product_id       UUID REFERENCES products ON DELETE SET NULL,
    match_confidence REAL,
    candidates       JSONB NOT NULL DEFAULT '[]',
    UNIQUE (receipt_id, position)
);
