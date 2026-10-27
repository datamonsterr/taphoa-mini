-- X1 decision 7: reset store data before replacing local sessions with Clerk identity.
-- FK inventory (0001..0604): stores cascades to members, sessions, invites, images,
-- categories, products, product_units, product_images (via products/images),
-- product_embeddings, price_history, scans, detections, sales, sale_lines,
-- sale_scans (via sales/scans), expenses, purchase_lines, margin_alerts,
-- day_closes, change_log, outbox_events, change_log_floor, product_prototypes,
-- index_jobs, stock_movements, receipts, receipt_lines,
-- stock_adjustment_requests and receipt_requests.
-- images.store_id is nullable: explicit inclusion also documents the orphan reset.
-- All SQL idempotency tables have a stores FK. Rate and generic idempotency
-- counters live in Redis, not PostgreSQL; there are no unlinked SQL tables.
TRUNCATE stores, images, outbox_events, stock_adjustment_requests, receipt_requests CASCADE;

ALTER TABLE members ADD COLUMN clerk_user_id TEXT NOT NULL;
ALTER TABLE members ADD CONSTRAINT members_store_clerk_user_unique UNIQUE (store_id, clerk_user_id);
CREATE INDEX members_active_clerk_user ON members (clerk_user_id) WHERE active;

ALTER TABLE sales DROP COLUMN session_id, ADD COLUMN clerk_session_id TEXT;
DROP TABLE sessions;
ALTER TABLE stores DROP COLUMN recovery_code_hash, DROP COLUMN recovery_code_lookup;
