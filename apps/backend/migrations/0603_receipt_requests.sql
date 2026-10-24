-- Store-scoped HTTP idempotency independent of receipt status and OCR availability.
-- Hash arbitrary keys so index sizes stay bounded. URLs are always generated on read.
CREATE TABLE receipt_requests (
    store_id UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('create', 'confirm')),
    key_hash BYTEA NOT NULL CHECK (octet_length(key_hash) = 32),
    request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
    receipt_id UUID NOT NULL REFERENCES receipts ON DELETE CASCADE,
    PRIMARY KEY (store_id, operation, key_hash)
);
