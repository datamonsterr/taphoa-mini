# E3 Catalog: task list and test plan

## Tasks (dependency order, DoD each)

| #   | Task                                                                                                                                                                                                                                                            | Depends   | DoD                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| T1  | Migration `02xx`: pg_trgm/unaccent index check, keyset indexes (`products (store_id, id)`), `price_history` cursor index                                                                                                                                        | E1 schema | `sqlx migrate run` clean on empty DB; EXPLAIN uses index for `q` search |
| T2  | `catalog::categories` (list, create, 409 on duplicate name, Lead only, emit `catalog.changed`)                                                                                                                                                                  | E1        | unit + integration + contract                                           |
| T3  | `catalog::products` read: list (q, barcode, category_id, include_archived, keyset), get, price-history                                                                                                                                                          | T1        | single-query list; pagination tests                                     |
| T4  | `catalog::products` create (enroll): authz, validation, idempotency on id, embed images via `Embedder`, duplicate check via `VectorIndex` at 0.88 -> 409 `duplicate_suspected` with `details.candidates`, `force_new`, units, price_history initial row, events | T1,T3     | unit + integration + contract                                           |
| T5  | patch (merge-patch: name/price/cost/units/barcode/category/archived), version bump, price_history rows, `catalog.changed` + `price.changed`; archive (DELETE)                                                                                                   | T4        | Lead-only price/cost/archive                                            |
| T6  | product images add/delete (max 5, min 1, embedding row, detection_id crop optional)                                                                                                                                                                             | T4        | 409 rules                                                               |
| T7  | `/v1/images` alignment: presigned URL, `purpose`, store from token, GET image                                                                                                                                                                                   | E1        | contract                                                                |
| T8  | `/v1/exports/price-list` pdf and png                                                                                                                                                                                                                            | T3        | content-type + non-empty body                                           |
| T9  | e2e `packages/e2e/tests/catalog.test.ts`, contract tests, CI green, PR                                                                                                                                                                                          | all       |                                                                         |

## Test cases per endpoint (every endpoint)

Common: 401 without token; store isolation (other store's ids -> 404); 400 validation envelope;
Seller without `can_enroll` -> 403 on enroll; Lead-only on price/cost/archive/category create.

- GET /v1/products: happy; `q` accent-insensitive ("hao hao" finds "Hảo Hảo"); barcode exact; category filter; archived hidden by default and shown with include_archived; limit + cursor walk without dups or gaps; bad cursor -> 400.
- POST /v1/products: 201 happy (Lead; Seller+can_enroll); 403 Seller w/o can_enroll; 400 (no images, >5, negative price); 200 identical replay, 409 `id_conflict` different body; 409 `duplicate_suspected` at similarity >= 0.88 with candidates, `force_new` bypasses; units; barcode unique -> 409; emits change_log + outbox same tx; 503 when embedder down and nothing persisted; image from another store -> 404.
- GET /v1/products/{id}: happy, 404 other store, 404 unknown.
- PATCH: name edit by Seller with can_enroll? (name allowed per matrix check); price by Seller -> 403; price change writes price_history old/new/source=manual and version+1 and `price.changed`; cost change; units replacement writes unit_price history; no-op patch leaves version; archive via patch archived=true.
- DELETE: Lead 204, Seller 403, repeat 404 or 204 (decide per contract), hidden from list.
- POST images: 201 with embedding row; 6th -> 409; unknown image -> 404; Seller w/o can_enroll -> 403.
- DELETE images: 204 removes embedding; last image -> 409; 404.
- GET price-history: newest first, pagination, 404 other store.
- GET/POST /v1/categories: list; create 201 Lead; 403 Seller; 409 duplicate name (case-insens.); 400 empty/41 chars; id replay.
- GET /v1/exports/price-list: pdf default (`%PDF`), png (PNG magic), bad format 400, excludes archived.
- /v1/images: POST multipart 201 with presigned url + purpose; 413, 415, 400 bad store; GET returns fresh url; other store 404.
