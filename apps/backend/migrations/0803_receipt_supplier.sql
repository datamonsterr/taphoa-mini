-- Optional supplier metadata for assistant purchase history; older receipts remain unknown.
ALTER TABLE receipts ADD COLUMN supplier TEXT
    CHECK (supplier IS NULL OR char_length(supplier) BETWEEN 1 AND 120);
