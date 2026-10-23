-- 3.2 Images — reconcile existing table from 0002/0003 with the full spec.
-- store_id stays nullable (spec: "nullable until auth lands; keep nullable for now").
-- Add missing columns; keep existing object_key/content_type/purpose constraints.
ALTER TABLE images
    ADD COLUMN width        INT,
    ADD COLUMN height       INT,
    ADD COLUMN uploaded_by  UUID REFERENCES members,
    ADD CONSTRAINT images_byte_size_max CHECK (byte_size <= 10485760);

-- Composite index for handler queries (store_id first).
CREATE INDEX images_store_created ON images (store_id, created_at DESC);
