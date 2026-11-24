-- Filter out NULL embeddings in scan_search_products so rows with only 768-d vectors
-- (or unpopulated 384-d vectors after migration 1306) do not evaluate <=> to NULL and sort
-- to the top of scan results (due to Postgres default NULLS FIRST in ORDER BY DESC).
-- Matches recognition::pgvector::SEARCH_SQL.
CREATE OR REPLACE FUNCTION scan_search_products(query vector, p_store uuid, p_model text, p_fetch bigint, p_limit bigint)
RETURNS TABLE (product_id uuid, similarity real)
LANGUAGE sql STABLE
SET hnsw.iterative_scan = 'relaxed_order'
SET hnsw.ef_search = 100
SET hnsw.max_scan_tuples = 20000
AS $$
WITH nearest AS MATERIALIZED (
    SELECT e.product_id, e.embedding <=> query AS distance
    FROM product_embeddings e
    WHERE e.store_id = p_store AND e.model = p_model AND e.embedding IS NOT NULL
      AND EXISTS (SELECT 1 FROM products p
                  WHERE p.id = e.product_id AND p.store_id = p_store AND NOT p.archived)
    ORDER BY e.embedding <=> query
    LIMIT p_fetch
), scores AS (
    SELECT n.product_id, 1 - n.distance AS similarity FROM nearest n
    UNION ALL
    SELECT proto.product_id, 1 - (proto.embedding <=> query) AS similarity
    FROM product_prototypes proto
    JOIN products p ON p.id = proto.product_id
    WHERE proto.store_id = p_store AND proto.model = p_model AND proto.embedding IS NOT NULL
      AND p.store_id = p_store AND NOT p.archived
)
SELECT s.product_id, max(s.similarity)::real AS similarity
FROM scores s
GROUP BY s.product_id
ORDER BY similarity DESC, product_id
LIMIT p_limit
$$;
