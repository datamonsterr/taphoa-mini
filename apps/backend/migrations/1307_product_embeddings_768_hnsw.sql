DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'product_embeddings_768_hnsw'
          AND NOT i.indisvalid
    ) THEN
        DROP INDEX product_embeddings_768_hnsw;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS product_embeddings_768_hnsw
    ON product_embeddings USING hnsw (embedding_768 vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

