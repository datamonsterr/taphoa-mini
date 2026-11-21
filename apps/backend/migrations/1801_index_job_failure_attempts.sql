-- Keep claims monotonic for fencing/backoff; availability retries do not spend this budget.
ALTER TABLE index_jobs ADD COLUMN failure_attempts integer NOT NULL DEFAULT 0;
UPDATE index_jobs SET failure_attempts = attempts;
