-- OCR lines cannot be recovered reliably from the joined OCR text; legacy
-- receipts remain NULL and newly scanned receipts record the actual count.
ALTER TABLE receipts ADD COLUMN ocr_line_count INTEGER CHECK (ocr_line_count >= 0);
