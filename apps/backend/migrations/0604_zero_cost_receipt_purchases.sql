-- ReceiptConfirm permits free supplier items (cost >= 0), including all-free
-- receipts. The public expense create/patch validators still require amount > 0.
ALTER TABLE expenses DROP CONSTRAINT expenses_amount_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_amount_check
    CHECK (amount > 0 OR (amount = 0 AND category = 'nhap_hang'));
