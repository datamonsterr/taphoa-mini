-- no-transaction
-- A concurrent index must be the sole SQL statement in this migration to allow
-- CREATE INDEX CONCURRENTLY outside a transaction block.
--
-- Leftover invalid index handling:
-- If an interrupted migration or transient failure leaves behind an invalid index
-- (where pg_index.indisvalid = false), Postgres's IF NOT EXISTS will detect the
-- relation name and skip creation without completing the index build.
-- Recovery: manually run
--   DROP INDEX CONCURRENTLY IF EXISTS product_prototypes_768_hnsw;
-- before re-running the migration, or drop the invalid index prior to execution.
CREATE INDEX CONCURRENTLY IF NOT EXISTS product_prototypes_768_hnsw
    ON product_prototypes USING hnsw (embedding_768 vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
