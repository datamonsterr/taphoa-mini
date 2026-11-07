# Collecting evaluation datasets

Enroll about 50 real products with clear reference photos. Include look-alike
products. Make at least 200 real checkout scans in varied conditions, including
poor lighting, and confirm or correct every item before completing each sale.
Voided sales are excluded. Enrollment and checkout must use separate photos.

Turn on voice donation with the speaker's consent. Record at least 40 varied real
voice sales, including different products, quantities, payment methods, speakers,
and shop noise. Confirm or correct each sale. Export donations promptly: donated
clips are deleted after at most 30 days, possibly sooner if retention is configured
below 30 days.

## Export

Run from the repository root with Python 3, `psycopg` 3 and `boto3` installed;
`ffmpeg` is also needed for WAV or OGG voice clips. Set `DATABASE_URL`,
`AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_DEFAULT_REGION`, `AWS_S3_BUCKET_NAME`, and `S3_FORCE_PATH_STYLE` to the
store's database and private bucket settings. Protect these credentials. Set the
store UUID and private output path in your shell:

```bash
STORE_ID='your-store-uuid'
DATA_DIR='/secure/path/datasets'
apps/backend/scripts/export-recognition-set.sh --store "$STORE_ID" --output "$DATA_DIR/a1"
apps/backend/scripts/export-voice-golden.sh --store "$STORE_ID" --output "$DATA_DIR/voice"
```

Both exporters only read the database and bucket. Recognition accepts optional
`--start YYYY-MM-DD`, `--end YYYY-MM-DD` (inclusive sale business dates),
`--min-per-product N`, `--max-per-product N` (checkout detections), and
`--products UUID,UUID`. It prints product counts and whether 50 products and
200 distinct checkout scans are present. The A1 manifest is
`$DATA_DIR/a1/manifest.json`. The evaluator also rejects duplicate decoded images;
resolve any duplicates before relying on a result.

The voice exporter writes one audio file and JSON sidecar per donation; its
manifest is `$DATA_DIR/voice/metadata/manifest.json`. Repeating the export skips
existing complete clips and preserves reviews. Only confirmed or edited voice
sales are selected. Exported transcript and spoken phrases come from the model,
not a listener. Corrections and linked completed-sale lines help with review, but
can differ from what was spoken. Each new sidecar is marked `unreviewed` and
contains `original_draft` and `confirmed_sale_lines` alongside provisional
`lines`.

## Review and evaluate

For each voice clip, listen to the recording, correct its sidecar `transcript`
and `lines` to match what was actually said, check payment and customer fields,
and then set `review_status` to `reviewed`. In particular, set `unit_price` to
`null` if no price was spoken, even if a catalog price was charged. The evaluator
skips cases explicitly marked `unreviewed`. Older curated golden sidecars without
this field remain eligible for scoring. Product names or IDs
must correspond to the catalog in the evaluation store.

Fetch the pinned recognition model and runtime, then run the recognition eval:

```bash
apps/backend/scripts/fetch-models.sh
apps/backend/scripts/fetch-onnxruntime.sh
apps/backend/scripts/embed-accuracy.sh "$DATA_DIR/a1/manifest.json" > "$DATA_DIR/a1/result.json"
```

For voice, configure `BACKEND_URL`, `EVAL_STORE_ID` and `EVAL_LEAD_TOKEN` (or
`CLERK_SECRET_KEY`) for the evaluation backend, then run:

```bash
pnpm --filter @taphoa/eval voice -- --dir "$DATA_DIR/voice" --out "$DATA_DIR/voice-results" --no-posthog
```

Voice JSON and Markdown results are written to `voice-results`; recognition JSON
is written to `a1/result.json`. Keep the manifest and images with the result for
reproducibility. Private source data stays in the private bucket; exported copies
and results also contain sensitive shop data, so store them privately, restrict
access, and delete them when no longer needed. Obtain the speaker's consent before
donating or using voice clips.
