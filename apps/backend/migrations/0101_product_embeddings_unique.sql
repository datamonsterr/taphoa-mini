-- One row per reference key (store_id, product_id, image_id, model), matching the
-- VectorIndex upsert semantics: re-enrolling the same photo and model replaces the
-- stored embedding via INSERT ... ON CONFLICT (store_id, product_id, image_id, model)
-- DO UPDATE instead of appending duplicates.
CREATE UNIQUE INDEX product_embeddings_reference_key
    ON product_embeddings (store_id, product_id, image_id, model);
