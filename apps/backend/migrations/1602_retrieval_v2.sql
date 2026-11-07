-- Additive metadata; existing crop/cutout rows remain original views.
-- Reverting the application must first stop v2 workers and restore the previous
-- unique index after removing non-original views; never drop the vector column.
ALTER TABLE product_embeddings ADD COLUMN augmentation TEXT NOT NULL DEFAULT 'original'
    CHECK (augmentation IN ('original', 'rotate90', 'rotate180', 'rotate270',
                            'occlude_tl', 'occlude_br', 'far48'));
DROP INDEX product_embeddings_reference_key;
CREATE UNIQUE INDEX product_embeddings_reference_key
    ON product_embeddings (store_id, product_id, image_id, model, kind, augmentation);

-- Record the attempted model so periodic backfill does not reset exhausted retries.
ALTER TABLE index_jobs ADD COLUMN target_model TEXT;
CREATE INDEX index_jobs_product_model ON index_jobs (product_id, target_model);
