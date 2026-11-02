# Retrieval v2

Keyframe enrollment keeps all 8–24 image rows, but indexes at most 16 frames selected
by deterministic greedy farthest-point sampling, starting nearest the mean embedding.
Unselected frames retain no embeddings. Selected frames contribute crop views only:
original, rotate90, rotate270 and far48. At the default keep limit this stores at most
16 × 4 = 64 embeddings; selecting from 24 frames additionally requires eight original
embeddings that are discarded (72 total inference views). Legacy photos retain their
seven-view crop and cutout indexing. Real-model indexing time has not been measured.
`KEYFRAME_KEEP` can lower the default of 16 to a value from 1 through 16.
Image uploads have no per-upload rate limit in the API router or handler, so 24 parallel
enrollment uploads do not exhaust an application upload rate limit.

DINOv2 ViT-S/14 ONNX and 384-dimensional vectors stay unchanged. Retrieval v2 improves
reference coverage for products rotated, distant, or partly covered at checkout. Accuracy
still needs evaluation on labeled shop photos; these changes do not establish a new accuracy claim.

## Preprocessing

Both queries and references keep the existing 8% bbox padding. DINO preprocessing now
resizes the longest edge to 224 px and centres the result in a square filled with RGB
`(124, 116, 104)`, the rounded ImageNet mean. This preserves package geometry instead of
stretching a tall bottle into a square. Normalization and the CLS token stay unchanged.
`EMBED_SIDE` still accepts multiples of 14 from 56 through 224. The model identity is
`dinov2-vits14-onnx@2/lb{side}` so old stretch vectors never mix with letterbox vectors.

## Index augmentation

The index job embeds seven deterministic views of each crop and each cutout: original,
90/180/270 degree rotations, top-left and bottom-right crops retaining approximately 70%
of the area, and a far view downscaled to a longest edge of 48 px then restored. Subcrops
retain `sqrt(0.7)` of each edge, rounded to pixels. Tiny inputs remain at least one pixel.
`INDEX_AUGMENT=0` disables the six extra views for subsequent jobs. A configuration change
requires explicitly re-enqueuing products already indexed with that model identity.

Migration `1303_retrieval_v2.sql` adds `augmentation` (default `original`) beside the
existing `kind` (`crop`/`cutout`). The unique key includes both, while existing rows keep
their meaning. `index_jobs.target_model` records attempts so an exhausted job is
not repeatedly reset by background backfill. No vector column or dimension changes.
Index publication atomically replaces the product's vector set and recomputes its normalized mean prototype. Each variant retains
the source reference image ID; the indexed event still counts source photos, not variants.

## kNN voting

`EMBED_KNN` defaults to 20 reference votes. Search overfetches nearest reference rows,
retains at most three per product, then chooses the closest voting neighborhood. The vote
budget is at least three times the requested product limit so a top-k response can contain
enough products. Overfetch is at least eight times that budget and 112 rows per requested
product (the maximum eight photos × two kinds × seven views), with a minimum of 32 rows. Both
checkout and enrollment duplicate detection use the same SQL and neighborhood settings.

A product's score is the sum of its top three reference cosine similarities divided by
three. Missing hits contribute zero: a single 0.99 hit scores 0.33, while three 0.90 hits
score 0.90. A prototype contributes its cosine only if the product has no reference vote
in the neighborhood. A strong prototype cannot override weak reference evidence. Ranking
is by product score, then product ID; the match margin compares the first two products.

Existing thresholds are unchanged: `MATCH_THRESHOLD=0.80`, `MATCH_MARGIN=0.05`,
`MATCH_FLOOR=0.60`, and `DUPLICATE_THRESHOLD=0.88`. They remain configurable. No threshold retuning or model change is included.

## Model backfill and latency

The index worker periodically enqueues a bounded batch of active products with reference
photos but without embeddings for the current model, excluding pending products and
exhausted jobs for that model. Failed jobs for an older model can be upgraded. Startup
performs the first batch immediately. Product row locks and the existing pending state make concurrent scans
idempotent; failed jobs retain the normal bounded retry policy. Successful publication
removes incompatible old model vectors and prototypes. Historical scans keep their model
identity and recorded candidate scores.

Scans accept a JSON multipart `boxes` array (up to 10 normalized, EXIF-oriented boxes with optional `track_id`); nonempty arrays skip SAM. A single multi-mode phone box also compares a whole-frame embedding. Ambiguous detections use three augmented views, capped at 12 additional embeddings per scan; `SCAN_TTA=0` disables them. Indexing adds
background work and vector storage. The 224 px latency measurements and reproduction
commands live in [recognition-latency.md](recognition-latency.md).

## Validation

From `apps/backend`, run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
and `cargo test`. With the README's Postgres, Redis and storage configuration, run
`cargo test -- --include-ignored --test-threads=1`. Index-worker tests use SQLx-managed
isolated databases, so the database role needs `CREATEDB`; each successful test removes
its temporary database. Tests cover geometry and mean padding, view count/determinism,
three-hit voting and product margins, prototype fallback, model backfill idempotence,
startup batch limits, exhausted retries, and configurable duplicate thresholds.

## Offline GroceryStoreDataset evaluation (2026-11-02)

The [recognition evaluation](../../apps/backend/eval/results/2026-11-02-recognition.md)
uses 65 enrolled and 16 held-out fine-grained classes, four test photos per class,
and nine synthetic buckets. V2 K=8 achieved 51.5% aggregate top-1 on enrolled
queries; it does not meet C2's 90% target. The dataset crops can contain their
original background, and exact in-memory cosine neighbors do not measure production
HNSW recall. The measured run took 35 minutes 14 seconds on the shared host with
four ONNX threads.

The following exploratory (threshold, margin) pairs maximize matched coverage at
at least 98% matched precision **on the same observations used for the sweep**.
Coverage includes held-out-class queries in its denominator. These are candidate
settings for independent validation, not evidence that production will achieve 98%
precision. The matched samples are few and coverage is low. Production defaults
remain unchanged.

| Configuration |  Threshold |     Margin | Matched precision |        Coverage |
| ------------- | ---------: | ---------: | ----------------: | --------------: |
| Legacy K=3    | 0.62277216 | 0.16118395 |   110/112 (98.2%) | 112/2916 (3.8%) |
| V2 K=3        | 0.61356014 | 0.26671749 |   116/118 (98.3%) | 118/2916 (4.0%) |
| V2 K=8        | 0.82424557 | 0.11803502 |   148/151 (98.0%) | 151/2916 (5.2%) |
| V2 K=16       | 0.72450733 | 0.19568455 |   162/165 (98.2%) | 165/2916 (5.7%) |

## Embedder comparison (2026-11-02)

The [offline embedder experiment](../../apps/backend/eval/results/2026-11-02-embedders.md)
found that pooled SigLIP2 base increased K=8 top-1 from 51.5% to 76.2% on the
same enrolled GroceryStoreDataset queries, and from 18.7% to 67.3% on its packaged
goods subset. CLS plus GeM on DINOv2 small scored 49.9% overall. SigLIP2 took
242.4 ms per crop versus 164.2 ms for the baseline on the shared four-thread host;
these are crop inference measurements, not end-to-end scan latency. SigLIP2 emits
768-dimensional embeddings, so adopting it would require a vector schema migration
and complete reindexing. These results neither meet C2's 90% target nor validate
real shop photos; production defaults remain unchanged.
