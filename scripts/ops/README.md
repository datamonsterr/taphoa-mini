# scripts/ops

One-off operational scripts. They are not part of the app build or CI.

## delete_orphan_images.py

Deletes bucket image objects that no Postgres row references. It is written for the X1 data reset: migration `0701_clerk_identity.sql` truncates the store-scoped `images` table, so the objects stay in the bucket with no row pointing at them.

- Dry run is the default. It prints counts and up to 20 sample keys and deletes nothing.
- `--apply` deletes with `DeleteObjects` in batches of 1000. Per-key errors go to stderr and the script exits 1.
- Only objects last modified more than `--min-age-minutes` ago (default 60) are candidates. This keeps uploads that are not yet committed.

### Referenced keys

| Table.column        | Source                                                |
| ------------------- | ----------------------------------------------------- |
| `images.object_key` | `0002_images.sql` (the only column that stores a key) |

Other columns that point at images hold UUIDs, not keys, so they add nothing to the referenced set: `scans.image_id`, `detections.crop_image_id`, `product_images.image_id`, `product_images.cutout_image_id`, `product_embeddings.image_id`, `expenses.image_id` and `receipts.image_id`. The constant `REFERENCED_KEY_COLUMNS` in the script holds the list and each source migration.

### Listed prefixes

| Prefix                            | Written by                                                                  |
| --------------------------------- | --------------------------------------------------------------------------- |
| `images/<YYYY>/<MM>/<uuid>.<ext>` | `images.rs`, `recognition/handlers.rs`                                      |
| `<YYYYMMDD>/<uuid>.jpg`           | `recognition/segment_points.rs` (cutouts; bucket root, no `images/` prefix) |

Nothing else in the bucket is listed or deleted.

### Environment

| Variable                | Notes                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`          | Postgres URL. Never printed.                                                   |
| `AWS_ENDPOINT_URL`      | S3-compatible endpoint. Never printed.                                         |
| `AWS_ACCESS_KEY_ID`     | Never printed.                                                                 |
| `AWS_SECRET_ACCESS_KEY` | Never printed.                                                                 |
| `AWS_S3_BUCKET_NAME`    | Bucket name.                                                                   |
| `AWS_DEFAULT_REGION`    | `auto` for Tigris.                                                             |
| `S3_FORCE_PATH_STYLE`   | Optional. `true`, `1` or `yes` for path-style addressing, as the backend uses. |

Error text is scrubbed of these values before it is printed.

### Load Railway credentials

Run from the repository root with bash. Do not echo these outputs or write them to a file. `railway_env.py` needs `RAILWAY_TOKEN` or a linked Railway CLI, and it defaults to the `test` environment when none is given.

```bash
while IFS= read -r line; do export "$line"; done < <(
  python3 -I scripts/ci/railway_env.py <env> 2>/dev/null | grep '^DATABASE_URL='
)
while IFS= read -r line; do export "$line"; done < <(
  railway variables --service backend --environment <env> --kv | grep -E '^(AWS_|S3_FORCE_PATH_STYLE=)'
)
```

`<env>` is the Railway environment name, for example `test`.

### Run

Dry run first. Check the counts and sample keys:

```bash
uv run --with boto3 --with 'psycopg[binary]' scripts/ops/delete_orphan_images.py
```

Then delete:

```bash
uv run --with boto3 --with 'psycopg[binary]' scripts/ops/delete_orphan_images.py --apply
```

Exit codes: 0 for success or a dry run, 1 for a runtime error or a per-key delete error, 2 for missing variables or bad arguments.

### Tests

```bash
python3 -I scripts/ops/test_delete_orphan_images.py -v
python3 -I -m unittest discover -s scripts/ops -v
```

The tests use fakes only. They need no network, database or bucket, and no boto3 or psycopg. Under `-I`, `unittest scripts/ops/test_delete_orphan_images.py` cannot import the file, because unittest converts the path to a dotted module name and the working directory is not on `sys.path`. Use one of the two commands above.
