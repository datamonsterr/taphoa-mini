# Embedder accuracy evidence

`docs/PRD.md` A1 calls for 50 real products and 200 checkout scans. The repository
contains shelf and receipt smoke fixtures, but no labeled A1 dataset, enrollment
references, query crops, or dataset download source. Obtain those from the owner;
do not report a fixture smoke run as A1 accuracy.

Create an external JSON manifest. Paths resolve relative to the manifest:

```json
{
  "references": [
    { "product_id": "lavie-500", "image": "enroll/lavie-500-front.jpg" },
    { "product_id": "lavie-350", "image": "enroll/lavie-350-front.jpg" }
  ],
  "queries": [
    {
      "product_id": "lavie-500",
      "image": "checkout/001.jpg",
      "bbox": [40, 20, 100, 200]
    }
  ]
}
```

Use independent enrollment photos and labeled held-out query crops. Omit `bbox`
for pre-cropped images; otherwise the evaluator applies production's 8% crop
padding. Duplicate decoded crops, missing labels, and empty sets fail explicitly.
This measures the embedder on labeled crops; segmentation quality and human
confirmation are separate from this measurement. Keep the exact manifest/images
with the result so it can be reproduced.

From the repo root, fetch the checksum-pinned CI assets:

```bash
apps/backend/scripts/fetch-models.sh
apps/backend/scripts/fetch-onnxruntime.sh
apps/backend/scripts/embed-accuracy.sh /path/to/a1/manifest.json > /path/to/a1/result.json
```

The wrapper accepts `DINO_MODEL_PATH`, `ORT_DYLIB_PATH`, and standard Cargo
build settings. `ACCURACY_PROFILE=dev` selects a development build for smoke tests;
the default is `release`.

The evaluator uses production DINOv2 at exactly 112 px, scores each product by
its best reference or normalized mean prototype, and prints JSON with top-1
percentage, counts, model/manifest SHA-256, and individual predictions. Ties count
as incorrect. Exit 0 means accuracy >=90%; exit 1 means below target; exit 2 means
invalid input or inference failure. `meets_a1_sample_counts` must also be true
before claiming the A1 sample requirement. A missing manifest fails before any
model is loaded. No service, auth, or database is needed.

## GroceryStoreDataset retrieval evaluation

`scripts/eval-recognition.sh` runs the offline, fine-grained GroceryStoreDataset
benchmark. The dataset archive is pinned and SHA-256 verified; its images, model
assets, and gallery embeddings live in `apps/backend/.cache/eval` and are never
committed. The script fetches the pinned models and ONNX Runtime unless
`DINO_MODEL_PATH` and `ORT_DYLIB_PATH` point to existing assets. Build and model
inference use four threads by default. Pass `--max-test-per-class N` (default 4)
to increase the deterministic per-class test cap, or set `EVAL_TEST_PER_CLASS`.
Set `EVAL_CACHE_DIR` to move the cache. Output is a dated Markdown report and JSON observations under
`eval/results/`. The seed is 42. The legacy configuration uses 112 px stretched
inputs and best-reference/prototype scoring; retrieval v2 uses the production
224 px embedder, index augmentation, voting and classifier. Search requests
`top_k=5`. Neighbor search is an exact in-memory cosine scan; production uses
approximate HNSW, so its results can differ. V2 is reported at K=3, 8 and 16,
and legacy at K=3. The synthetic object is the dataset crop itself,
which can already contain scene background; this is not an instance mask.
Held-out classes are never indexed. Mid and far scenes use the pasted box and
production 8% padding. The rotation, occlusion and distance scenarios vary one
factor at a time except `hard`. Confidence intervals are Wilson intervals over
observations, and repeated transforms of the same photos are correlated.
The threshold and margin sweep uses exact observed decision boundaries on the
evaluated samples; it is not an independent estimate of future precision. No production thresholds
are changed. The existing eval workflow targets the live assistant/voice stack,
so this offline, CPU-intensive benchmark is not attached to that workflow.
