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
