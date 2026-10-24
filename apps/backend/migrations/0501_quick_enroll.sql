-- 0501_quick_enroll.sql
-- Quick enroll data model: 8 reference photos, cutout masks, prototypes, and background index jobs.

-- 1. product_images: expand position check to 0..7 and add cutout/bbox fields.
ALTER TABLE product_images DROP CONSTRAINT product_images_position_check;
ALTER TABLE product_images ADD CONSTRAINT product_images_position_check CHECK (position BETWEEN 0 AND 7);
ALTER TABLE product_images ADD COLUMN cutout_image_id UUID REFERENCES images;
ALTER TABLE product_images ADD COLUMN bbox REAL[] CHECK (bbox IS NULL OR array_length(bbox, 1) = 4);

-- 2. products: index_status for asynchronous prototype and embedding generation.
ALTER TABLE products ADD COLUMN index_status TEXT NOT NULL DEFAULT 'ready'
    CHECK (index_status IN ('pending', 'ready', 'failed'));

-- 3. product_embeddings: add kind ('crop' | 'cutout') and extend unique reference key.
ALTER TABLE product_embeddings ADD COLUMN kind TEXT NOT NULL DEFAULT 'crop'
    CHECK (kind IN ('crop', 'cutout'));
DROP INDEX IF EXISTS product_embeddings_reference_key;
CREATE UNIQUE INDEX product_embeddings_reference_key
    ON product_embeddings (store_id, product_id, image_id, model, kind);

-- 4. product_prototypes: per-product, per-model mean embedding over reference cutouts.
CREATE TABLE product_prototypes (
    store_id UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products ON DELETE CASCADE,
    model TEXT NOT NULL,
    embedding vector(384) NOT NULL,
    reference_count INT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, model)
);
CREATE INDEX product_prototypes_store_model ON product_prototypes (store_id, model);

-- 5. index_jobs: async worker queue for computing embeddings and updating prototypes.
CREATE TABLE index_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX index_jobs_run_after_queued ON index_jobs (run_after) WHERE status = 'queued';
CREATE INDEX index_jobs_store_id ON index_jobs (store_id);
