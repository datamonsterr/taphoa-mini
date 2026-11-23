# Scan vector search pool timeout (2026-11-23)

Production investigation used Railway SSH and `psql` with startup options
`default_transaction_read_only=on`, `statement_timeout=20000`,
`hnsw.iterative_scan=relaxed_order`, `hnsw.ef_search=100`, and
`hnsw.max_scan_tuples=20000`. `SELECT current_setting('transaction_read_only')`
returned `on`. Only SELECT and EXPLAIN statements ran against production; no
networking, deployment, database data, or schema configuration changed.

The production Postgres service currently has no public TCP proxy or
`DATABASE_PUBLIC_URL`, so SSH ran the already installed database client in the
Postgres container. Credentials were neither printed nor saved.

## SQL and indexes

The exact `SEARCH_SQL` from `crates/api/src/recognition/pgvector.rs` was explained
with `EXPLAIN (ANALYZE, BUFFERS)`, a real stored 384-dimensional reference vector,
the stored model `dinov2-vits14-onnx@1/112`, reference overfetch 40, and product
limit 5. Cases used the newest store without references and the store containing
references. The failed request's transient detection embeddings are unavailable;
the query structure, model, dimensions, and filters match the production path.

PostgreSQL 18.6, pgvector 0.8.7. Table statistics and sizes at inspection:

| Table              | Live rows | Dead rows | Heap | Total, including indexes |
| ------------------ | --------: | --------: | ---: | -----------------------: |
| product_embeddings |         3 |         0 | 8 kB |                    80 kB |
| product_prototypes |         3 |         0 | 8 kB |                    48 kB |
| products           |         3 |        20 | 8 kB |                   104 kB |

Relevant index definitions (all present):

```sql
CREATE INDEX product_embeddings_hnsw ON product_embeddings
    USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
CREATE INDEX product_embeddings_store ON product_embeddings (store_id, model);
CREATE UNIQUE INDEX product_embeddings_reference_key ON product_embeddings
    (store_id, product_id, image_id, model, kind);
CREATE INDEX product_prototypes_store_model ON product_prototypes (store_id, model);
CREATE UNIQUE INDEX product_prototypes_pkey ON product_prototypes (product_id, model);
CREATE UNIQUE INDEX products_pkey ON products (id);
CREATE INDEX products_store ON products (store_id) WHERE NOT archived;
```

Each of these indexes occupies 16 kB. The reference plan uses
`product_embeddings_reference_key` with both store and model in its index
condition, then joins active products, sorts distances, and applies the reference
limit. The prototype plan uses `product_prototypes_store_model` with both filters
in its index condition. HNSW is unused on this tiny dataset; there is no
filter-after-ANN plan in either case. No migration is justified by this evidence.

Empty-store plan excerpt (store UUID and embedding omitted):

```text
Limit (actual time=0.047..0.048 rows=0 loops=1)
  Buffers: shared hit=11
  CTE nearest
    Limit (actual time=0.023..0.023 rows=0 loops=1)
      Sort
        Nested Loop
          Index Scan using product_embeddings_reference_key on product_embeddings e
            Index Cond: ((store_id = '<store>') AND (model = 'dinov2-vits14-onnx@1/112'))
          Seq Scan on products (never executed)
  ...
  Index Scan using product_prototypes_store_model on product_prototypes proto
    Index Cond: ((store_id = '<store>') AND (model = 'dinov2-vits14-onnx@1/112'))
Planning Time: 0.415 ms
Execution Time: 0.119 ms
```

Populated-store plan: same access paths, three result products, ten shared buffer
hits, planning time 0.289 ms, execution time 0.081 ms. All buffers were cache hits.
The evidence does not support slow SQL execution or a missing vector index as the
cause of the reported multi-second delay.

## Connection occupancy

Read-only `railway status --json` deployment manifests locate the production
backend in `sin` (Singapore) and Postgres in `sfo` (San Francisco). The backend's
DB hostname is the private `postgres.railway.internal`; `DB_MAX_CONNECTIONS` is
unset (default 10). From the backend container, three TCP connection-only probes
to that hostname took 172.762 ms, 167.180 ms, and 172.067 ms. The probes sent no
SQL or application payload.

Each detection previously acquired a connection for at least six sequential
protocol exchanges: BEGIN, three separate SET LOCAL statements, SEARCH_SQL, and
COMMIT. Preparing uncached statements can add more exchanges. At approximately
170 ms per exchange, a connection is occupied for roughly a second even when
SQL execution takes less than a millisecond. Unbounded `join_all` over detections
therefore creates multiple waves behind ten connections; the tail can exceed the
three-second acquire timeout and also blocks unrelated requests and the outbox
relay. This explains the timing without attributing it to the database plan.

The fix sends the detection vectors as a pgvector array and evaluates the same
search SQL per vector in a correlated LATERAL query. Ordinality maps hits back to
the input detections, including empty hit lists. One transaction and connection
serve the entire scan's search phase; the three transaction-local HNSW settings
share one statement. Existing reference overfetch, prototype scoring, product
aggregation, tie ordering, thresholds, and `timings_ms.search` semantics remain.

Read-only production `EXPLAIN (ANALYZE, BUFFERS)` also checked the new LATERAL
statement with 24 copies of the stored vector. It kept the same B-tree access
paths, with 24 loops of each filtered search: empty-store execution 0.302 ms
(66 shared hits), populated-store execution 0.543 ms (240 shared hits, 72 result
rows). This confirms database execution of the batch, separately from the
undeployed HTTP path.

A local-only EXPLAIN with `enable_sort=off` verifies that the batch still offers
the parameterized ANN path when the planner chooses it:

```text
CTE nearest
  Limit
    Nested Loop
      Index Scan using product_embeddings_hnsw on product_embeddings e
        Order By: (embedding <=> q.embedding)
        Filter: ((store_id = '<store>') AND (model = '<model>'))
```

This is an access-path check, not a production performance measurement; production
settings were not forced to favor HNSW.

The regression runs a real 24-detection HTTP scan against a size-one pool with a
50 ms connection-held checkout delay and a 500 ms acquire budget. The old fan-out
returns HTTP 500; the batch path must return 201, preserve display order, and
persist its search timing. Adapter coverage also compares batched results with
the original single-vector SQL, including prototypes, archives, cutouts, model
and store isolation, ties, limits, and empty inputs.

No deployment was performed, so the fixed endpoint's production latency remains
unverified. Region placement is recorded as evidence; changing infrastructure is
outside this PR.
