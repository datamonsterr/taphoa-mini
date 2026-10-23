ALTER TABLE images
    ADD COLUMN purpose TEXT NOT NULL DEFAULT 'other'
    CHECK (purpose IN ('enrollment', 'checkout', 'crop', 'expense_receipt', 'other'));
