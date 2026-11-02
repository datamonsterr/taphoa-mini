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

`EMBEDDER=siglip2` is now the production default: Google SigLIP2 base patch16 224,
Apache-2.0, learned pooled output, 768 dimensions. `EMBEDDER=dinov2` selects the
retained DINOv2 ViT-S/14 CLS encoder (384 dimensions) for rollback. The
[class-disjoint B5 calibration](../../apps/backend/eval/results/2026-11-02-siglip2-production.json)
records threshold fitting and independent reporting. GroceryStoreDataset accuracy
remains below C2's 90% target and does not establish accuracy on real shop photos.

## Preprocessing

Both queries and references use 8% bbox padding, preserve aspect ratio, resize the
longest edge to the model input side and centre it on a square filled with the rounded
model mean. The same model spec selects preprocessing, named ONNX output and pooling;
every returned vector is finite, nonzero and L2-normalized.

| Setting          | SigLIP2 (default)                 | DINOv2 (rollback)                                         |
| ---------------- | --------------------------------- | --------------------------------------------------------- |
| Upstream         | `google/siglip2-base-patch16-224` | `facebook/dinov2-small`                                   |
| Input            | fixed 224 px                      | `EMBED_SIDE`, multiples of 14 within 56..224; default 224 |
| Mean / std       | `(0.5,0.5,0.5)` / `(0.5,0.5,0.5)` | ImageNet mean / std                                       |
| Padding RGB      | `(128,128,128)`                   | `(124,116,104)`                                           |
| Output / pooling | `output` / learned pooled output  | `last_hidden_state` / CLS token                           |
| Dimensions       | 768                               | 384                                                       |
| Model identity   | `siglip2-b16-224-onnx@1/lb224`    | `dinov2-vits14-onnx@2/lb{side}`                           |
| Path             | `SIGLIP2_MODEL_PATH`              | `DINO_MODEL_PATH`                                         |

`EMBED_THREADS` defaults to four. SigLIP2 ignores `EMBED_SIDE`; changing DINOv2's
side changes its identity and requires backfill. Model identity and dimension select
the search namespace and column, so old stretch, DINOv2 letterbox and SigLIP2 vectors
never vote together. The pinned export and quantization recipes are in
`apps/backend/scripts/export-embedder.py`, `quantize-embedder.py` and
`embedder-requirements.txt`; weights are hosted in a
[versioned prerelease](https://github.com/datamonsterr/taphoa-mini/releases/tag/models-siglip2-b16-224-v1)
and verified by `fetch-models.sh` at image build time.

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
not repeatedly reset by background backfill. Migration 1303 only changed metadata;
B5 adds the dimensions below.
Index publication atomically replaces the active model's vector set and recomputes its normalized mean prototype. Each variant retains
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

Both models use the B5 fit-only defaults below. `EMBEDDER=mock` retains the historical
0.80/0.05/0.60/0.88 boundaries for synthetic local/e2e adapters. Explicit env values
override their selected model's defaults. A margin compares product voting scores;
no individual augmented reference can satisfy a three-hit score on its own.

## Model backfill and latency

Scans and receipt/point inference share one execution slot with background indexing.
Foreground work waits up to `INFERENCE_QUEUE_WAIT_MS` (default 5000 ms) for that slot;
SigLIP2's seven-view indexing batches must not make brief contention an immediate 503.
Scan admission accepts at most four requests before parsing their multipart bodies.
A full admission queue or expired wait still returns `503 segmenter busy` with
`Retry-After: 1`. Model execution stays serialized and retains its permit through
cancellation; the wait does not increase model concurrency or hold a permit over
storage/database I/O. Background indexing keeps its existing FIFO semaphore wait.

The index worker periodically enqueues a bounded batch of active products with reference
photos but without embeddings for the current model, excluding pending products and
exhausted jobs for that model. Failed jobs for an older model can be upgraded. Startup
performs the first batch immediately. Product row locks and the existing pending state make concurrent scans
idempotent; failed jobs retain the normal bounded retry policy. Successful publication
retains other model vectors and prototypes for rollback. Historical scans keep their model
identity and recorded candidate scores.

### Additive schema and rollout

Migration `1306_siglip2_embeddings.sql` adds nullable `embedding_768 vector(768)`
to `product_embeddings`, `product_prototypes` and `detections`, and drops `NOT NULL`
from the two old `embedding vector(384)` reference columns. `scans` stores model
identity and contains no vector column. Existing 384-d rows remain untouched. The
schema changes request a brief metadata lock and fail after five seconds of lock
contention rather than queue indefinitely behind requests.

Migrations 1307 and 1308 create cosine HNSW indexes on the new reference/prototype
columns **concurrently**, one statement per non-transactional migration. They allow
old application instances to keep reading and writing 384-d rows during rollout.
A failed concurrent build may leave an invalid index; before retrying that migration,
inspect `pg_index.indisvalid` and remove only its invalid new index with
`DROP INDEX CONCURRENTLY`. Never remove a valid old index as part of this rollout.

Apply schema/index migrations while serving DINOv2. Include both model files in the
image, then switch `EMBEDDER=siglip2`. Startup immediately queues up to ten active
products with reference photos but no vectors for the exact active model ID; another
batch runs at most every 30 seconds. Existing inference admission and bounded retries
remain unchanged. Products awaiting their first SigLIP2 publication have no SigLIP2
candidates; plan for this backfill coverage window, or prefill with an unrouted worker
before directing identify traffic to SigLIP2. Monitor exact-model coverage and
`index_status`; a globally ready catalog is not evidence of SigLIP2 coverage.

Rollback is `EMBEDDER=dinov2` with the same earlier `EMBED_SIDE`. Retained old vectors
are immediately searchable. Products enrolled only during the SigLIP2 window need
DINOv2 backfill; the same model-aware worker handles them. Historical detections keep
their original dimension and scans retain their model ID/candidate snapshot. The later
cleanup migration may drop 384-d columns and old HNSW indexes only after the rollback
window, full SigLIP2 coverage and historical-data retention decisions. B5 does not
perform that cleanup.

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
precision. The matched samples are few and coverage is low. These historical DINOv2 observations do not select the SigLIP2 defaults below.

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
768-dimensional embeddings; B5 implements the additive migration and model-aware
reindex described above. These results neither meet C2's 90% target nor validate
real shop photos. B5's independent class split and quantization comparison are
recorded below; the original margin-withholding count is not a precision estimate.

## B5 threshold calibration

`apps/backend/scripts/fit-recognition-thresholds.py` uses the K=8 observations,
four queries per class and all nine buckets. It splits class IDs by the SHA256 of
`20261102:<class_id>`, separately within enrolled and unknown strata: the first
half fits, the remaining half reports. This gives 32 enrolled + 8 unknown fit
classes (1,440 queries) and 33 enrolled + 8 unknown report classes (1,476 queries).
All photos and transformations of a class stay on its side; the fixed 65-class
reference catalog is the same for both query halves.
The 95% policy follows examination of the initial 97% result; the same held half
is reused for descriptive comparison, not a new confirmatory test. The report half never selects
thresholds or tie breaks. Counts are correlated by source photo, so observed
precision is not a confidence guarantee or evidence for real shop images.

The match sweep tests every observed
float32 score and nonnegative product-score gap, maximizing accepted fit queries
at >=95% precision. A separate >=97% sweep is also reported. An unknown-class match
counts as an error. Ties prefer a lower margin, then a higher score threshold.
The floor is the highest observed known-query score retaining at least 95% of
enrolled fit queries at or above it, bounded above by the match threshold. Unknown
scores never select the floor. The floor only separates ambiguous from unknown
and cannot increase matched precision. Ambiguous results retain the top candidate
and alternatives in the app, so a known product below the match rule can still be
selected instead of being presented as a new product.

For enrollment, each of the eight original gallery photos becomes a query after
removing **all seven augmented views of that source photo** from references and
its prototype. Same product is positive; different product is negative. Exact
cosine retrieval reproduces the top-three reference cap, 20-vote neighborhood,
560-row overfetch, prototype fallback and top five candidates. Duplicate fitting
and reporting use disjoint 32-/33-class galleries to keep held class images out
of fitting entirely. This has fewer impostor classes than the full catalog; it
does not establish production duplicate recall. The threshold maximizes accepted
candidate pairs subject to >=97% fit precision. JSON results include the full
class lists, input hashes and duplicate pairs for auditing.

Reproduce after running the release evaluator for the selected artifact, using
its complete K=8 gallery (weights and dataset remain gitignored):

```sh
OPENBLAS_NUM_THREADS=4 .cache/b5/venv/bin/python scripts/fit-recognition-thresholds.py \
  .cache/b5/fp32/challenger-result.json .cache/b5/fp32/gallery-<cache-key>.json \
  eval/results/2026-11-02-siglip2-production.json
```

The command runs from `apps/backend`; the Python environment is pinned by
`scripts/embedder-requirements.txt`. Model artifacts and quantization accuracy are
compared before installing the resulting model-specific defaults. Runtime env
values override those defaults, so remove old explicit DINOv2 threshold variables
when enabling SigLIP2 unless their effect is intentional.

### Selected defaults and held-class results

The default match policy uses the 95% fit target. The original 97% fit policy
failed its held-class precision target; both policies below are reported without
claiming those targets on held classes or production. The higher floor recall
keeps known queries available as ambiguous suggestions instead of declaring them
new products. This trades unknown rejection for known-query retention.

| Model        | MATCH_THRESHOLD | MATCH_MARGIN | MATCH_FLOOR | DUPLICATE_THRESHOLD |
| ------------ | --------------: | -----------: | ----------: | ------------------: |
| SigLIP2 FP32 |     0.820157707 | 0.0780649185 | 0.797049701 |         0.972758532 |
| DINOv2 224   |     0.689468324 |  0.101004481 | 0.513753474 |         0.889570475 |

| Model        | Fit target |   Fit precision |  Held precision |    Held coverage |
| ------------ | ---------: | --------------: | --------------: | ---------------: |
| SigLIP2 FP32 |        95% | 117/123 (95.1%) | 124/149 (83.2%) | 149/1476 (10.1%) |
| SigLIP2 FP32 |        97% |   66/68 (97.1%) |   82/89 (92.1%) |   89/1476 (6.0%) |
| DINOv2 224   |        95% | 173/182 (95.1%) | 151/173 (87.3%) | 173/1476 (11.7%) |
| DINOv2 224   |        97% | 122/125 (97.6%) | 124/137 (90.5%) |  137/1476 (9.3%) |

The fit floor retains 1095/1152 known queries (95.1%) for either model.

| Model        | Held known queries at/above floor | Held unknown queries rejected | Held duplicate precision | Held duplicate same-product recall |
| ------------ | --------------------------------: | ----------------------------: | -----------------------: | ---------------------------------: |
| SigLIP2 FP32 |                 1145/1188 (96.4%) |                 24/288 (8.3%) |            43/44 (97.7%) |                     43/264 (16.3%) |
| DINOv2 224   |                 1144/1188 (96.3%) |                 15/288 (5.2%) |          153/170 (90.0%) |                    153/264 (58.0%) |

Duplicate fitting accepted 22/22 correct SigLIP2 pairs and 112/115 correct DINOv2
pairs. DINOv2's held duplicate precision also misses its 97% fit target. Neither
model's held match precision meets the 95% default-policy target. These are measured
limitations; collect independent shop photos before claiming precision guarantees.
DINOv2 calibration is for `lb224`; other `EMBED_SIDE` identities need their own
accuracy and threshold validation. Restore explicit historical env overrides if
rollback also requires identical earlier decision behavior.

Full fitting inputs, class lists, pair observations and counts are in the
[SigLIP2 result](../../apps/backend/eval/results/2026-11-02-siglip2-production.json)
and [DINOv2 result](../../apps/backend/eval/results/2026-11-02-dinov2-production.json).
A Rust replay test checks that the selected defaults reproduce held counts from
the committed query observations, including float32 score/gap boundaries.

### Dynamic INT8 experiment

The pinned ONNX Runtime 1.23.2 `quantize_dynamic` recipe quantizes MatMul/Gemm
weights per channel to signed INT8 with reduced range. Patch projection Conv stays
FP32. Both exports use the same pinned Python 3.11.15 environment, model revision,
pooled output, normalization, K=8 gallery, seed 42 queries and four ONNX threads.
The complete cached galleries were reused after verifying model and GenericEmbedder
cache identities; FP32 reproduces E2's exact 1782 correct top-1 queries.

| Artifact |       Bytes |    Enrolled top-1 |    Enrolled top-5 | Mean query embed ms/crop |
| -------- | ----------: | ----------------: | ----------------: | -----------------------: |
| FP32     | 371,803,508 | 1782/2340 (76.2%) | 2171/2340 (92.8%) |                    282.8 |
| INT8     | 101,719,427 | 1337/2340 (57.1%) | 1971/2340 (84.2%) |                    215.3 |

INT8 loses **19.0171 percentage points**, exceeding the strict <1.5-point adoption
limit. It is rejected; only FP32 is published and downloaded into the image. Query
timing overlaps background checks on the shared host; the separate release crop
benchmarks in [recognition-latency.md](recognition-latency.md) compare idle stage
latency. INT8 SHA256 is
`8d0be8d4e8fcc04679c370466a0e077c474e39c76dd824fbc47f9ce0781f2094`.
The [FP32 observations](../../apps/backend/eval/results/2026-11-02-siglip2-fp32.json)
and [INT8 observations](../../apps/backend/eval/results/2026-11-02-siglip2-int8.json)
are committed; weights and galleries remain in gitignored caches.
