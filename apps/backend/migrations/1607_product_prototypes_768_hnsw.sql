-- no-transaction
-- A concurrent index must be the sole SQL statement in this migration.
CREATE INDEX CONCURRENTLY product_prototypes_768_hnsw
    ON product_prototypes USING hnsw (embedding_768 vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
