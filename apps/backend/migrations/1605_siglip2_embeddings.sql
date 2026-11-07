-- Additive rollout: deploy schema before switching EMBEDDER. All existing rows remain.
-- Fail fast rather than queue an ACCESS EXCLUSIVE lock behind long-running requests.
SET LOCAL lock_timeout = '5s';
ALTER TABLE product_embeddings ADD COLUMN IF NOT EXISTS embedding_768 vector(768);
ALTER TABLE product_embeddings ALTER COLUMN embedding DROP NOT NULL;
ALTER TABLE product_prototypes ADD COLUMN IF NOT EXISTS embedding_768 vector(768);
ALTER TABLE product_prototypes ALTER COLUMN embedding DROP NOT NULL;
-- scans stores the embedder identity; only detections contains vectors (0007).
ALTER TABLE detections ADD COLUMN IF NOT EXISTS embedding_768 vector(768);
SET LOCAL lock_timeout = DEFAULT;

-- Rollback: EMBEDDER=dinov2; never drop old vectors here. A later, separately
-- scheduled migration may remove 384-d columns/indexes after the rollback window.
