-- Persist the request hash separately: 0601 keeps the ledger contract unchanged.
-- Keys are scoped to a store. Hashing keeps arbitrary HTTP keys within index limits.
CREATE TABLE stock_adjustment_requests (
    store_id UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    key_hash BYTEA NOT NULL CHECK (octet_length(key_hash) = 32),
    product_id UUID NOT NULL REFERENCES products ON DELETE CASCADE,
    request_hash BYTEA NOT NULL,
    movement_id UUID NOT NULL REFERENCES stock_movements ON DELETE CASCADE,
    PRIMARY KEY (store_id, key_hash)
);
