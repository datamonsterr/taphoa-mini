"""Delete bucket image objects that no Postgres row references.

One-off cleanup for after the X1 data reset: migration 0701_clerk_identity.sql
truncates the store-scoped ``images`` table, but the objects it pointed at stay in
the bucket with no row. Dry run by default; ``--apply`` deletes.

Run from the repository root:

    uv run --with boto3 --with 'psycopg[binary]' scripts/ops/delete_orphan_images.py          # dry run
    uv run --with boto3 --with 'psycopg[binary]' scripts/ops/delete_orphan_images.py --apply  # delete

Environment (values are never printed):

    DATABASE_URL           Postgres URL of the target environment
    AWS_ENDPOINT_URL       S3-compatible endpoint
    AWS_ACCESS_KEY_ID      S3 access key
    AWS_SECRET_ACCESS_KEY  S3 secret key
    AWS_S3_BUCKET_NAME     bucket name
    AWS_DEFAULT_REGION     region ("auto" for Tigris)
    S3_FORCE_PATH_STYLE    optional; true/1/yes for path-style addressing, as the backend uses

Options:

    --apply                 delete orphans (default: dry run, deletes nothing)
    --min-age-minutes N     only objects last modified more than N minutes ago can be
                            orphans (default 60); protects uploads not yet committed

Credentials for a Railway environment (bash; see scripts/ops/README.md):

    DATABASE_URL:  python3 -I scripts/ci/railway_env.py <env>
    AWS_*:         railway variables --service backend --environment <env> --kv

Load both into the environment without echoing them. Do not print or log their output.

Scope: a key is referenced if it appears in any column of REFERENCED_KEY_COLUMNS.
Only the prefixes in MANAGED_PREFIXES and the YYYYMMDD/ cutout folders at the bucket
root are listed. Nothing else in the bucket is read or deleted.

Exit codes: 0 success or dry run; 1 runtime error or per-key delete error;
2 missing environment variables or bad arguments.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote, urlsplit

# ---------------------------------------------------------------------------
# Referenced keys: every (table, column) that stores a bucket object key.
#
# Checked against apps/backend/migrations/*.sql and the Rust writers under
# apps/backend/crates/api/src. Only images.object_key stores a key:
#   images.object_key  0002_images.sql (TEXT NOT NULL UNIQUE); 0003_image_purpose.sql
#                      and 0005_images_reconcile.sql add columns only. Written by
#                      images.rs (POST /v1/images), recognition/handlers.rs (scan
#                      originals and detection crops), recognition/segment_points.rs
#                      (cutouts) and recognition/service.rs::persist_scan (crop rows).
#
# Columns that reference images but hold a UUID, not a key, so they add nothing here:
#   scans.image_id, detections.crop_image_id           0007_recognition.sql
#   product_images.image_id                            0006_catalog.sql
#   product_images.cutout_image_id                     0501_quick_enroll.sql
#   product_embeddings.image_id                        0006_catalog.sql
#   expenses.image_id                                  0009_expenses.sql
#   receipts.image_id                                  0601_stock_receipts.sql
# Export endpoints (reports/export.rs, catalog/export.rs) return bytes and write no object.
# ---------------------------------------------------------------------------
REFERENCED_KEY_COLUMNS: tuple[tuple[str, str], ...] = (
    ("images", "object_key"),  # 0002_images.sql
)

# ---------------------------------------------------------------------------
# Bucket prefixes the backend writes:
#   images/<YYYY>/<MM>/<uuid>.<ext>  images.rs and recognition/handlers.rs
#   <YYYYMMDD>/<uuid>.jpg            recognition/segment_points.rs (cutouts, no images/ prefix)
# The first family is listed by prefix. The second is found from the bucket root
# (delimiter "/") by keeping only folders named as a date.
# ---------------------------------------------------------------------------
MANAGED_PREFIXES: tuple[str, ...] = ("images/",)
CUTOUT_FOLDER_RE = re.compile(r"\d{8}/")

REQUIRED_ENV: tuple[str, ...] = (
    "DATABASE_URL",
    "AWS_ENDPOINT_URL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_S3_BUCKET_NAME",
    "AWS_DEFAULT_REGION",
)
# Values scrubbed from any error text before it is printed.
SECRET_ENV: tuple[str, ...] = (
    "DATABASE_URL",
    "AWS_ENDPOINT_URL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
)

DEFAULT_MIN_AGE_MINUTES = 60
DELETE_BATCH_SIZE = 1000  # S3 DeleteObjects limit
DRY_RUN_SAMPLE = 20


# ---------------------------------------------------------------------------
# Core logic. No I/O: listing, querying and deleting are injected.
# ---------------------------------------------------------------------------


def referenced_key_sql(table: str, column: str) -> str:
    return f"SELECT {column} FROM {table} WHERE {column} IS NOT NULL"


def collect_referenced_keys(query_fn: Callable[[str], list[str]]) -> set[str]:
    """Union of every non-null key stored in REFERENCED_KEY_COLUMNS."""
    keys: set[str] = set()
    for table, column in REFERENCED_KEY_COLUMNS:
        keys.update(query_fn(referenced_key_sql(table, column)))
    return keys


def managed_prefixes(root_prefixes: Iterable[str]) -> list[str]:
    """MANAGED_PREFIXES plus each YYYYMMDD/ folder among the bucket's top-level prefixes."""
    cutout_folders = sorted(p for p in root_prefixes if CUTOUT_FOLDER_RE.fullmatch(p))
    return [*MANAGED_PREFIXES, *cutout_folders]


def collect_bucket_keys(
    list_objects_fn: Callable[[str], list[dict]],
    prefixes: Iterable[str],
    *,
    min_age_minutes: int,
    cutoff: datetime | None = None,
) -> list[dict]:
    """Objects under ``prefixes`` last modified strictly before the cutoff.

    Each item has ``Key`` and a timezone-aware ``LastModified``. Keys outside the
    requested prefix and folder markers (keys ending in "/") are dropped.
    ``cutoff`` is injected by tests; production leaves it None and uses now().
    """
    if cutoff is None:
        cutoff = datetime.now(tz=timezone.utc) - timedelta(minutes=min_age_minutes)

    objects: list[dict] = []
    for prefix in prefixes:
        for obj in list_objects_fn(prefix):
            key: str = obj["Key"]
            if not key.startswith(prefix) or key.endswith("/"):
                continue
            last_modified: datetime = obj["LastModified"]
            if last_modified.tzinfo is None:
                last_modified = last_modified.replace(tzinfo=timezone.utc)
            if last_modified < cutoff:
                objects.append({"Key": key, "LastModified": last_modified})
    return objects


def find_orphans(bucket_objects: list[dict], referenced_keys: set[str]) -> list[dict]:
    """Bucket objects whose key no database row references, sorted by key."""
    orphans = [obj for obj in bucket_objects if obj["Key"] not in referenced_keys]
    return sorted(orphans, key=lambda obj: obj["Key"])


def delete_in_batches(
    delete_fn: Callable[[list[str]], list[dict]],
    orphan_keys: list[str],
) -> tuple[int, list[dict]]:
    """Delete keys in batches of DELETE_BATCH_SIZE.

    Returns (deleted_count, per_key_errors). Each error has ``Key``, ``Code``, ``Message``.
    """
    deleted = 0
    errors: list[dict] = []
    for start in range(0, len(orphan_keys), DELETE_BATCH_SIZE):
        batch = orphan_keys[start : start + DELETE_BATCH_SIZE]
        batch_errors = delete_fn(batch)
        deleted += len(batch) - len(batch_errors)
        errors.extend(batch_errors)
    return deleted, errors


def secret_values(env: Mapping[str, str]) -> list[str]:
    """Strings that must never appear in printed output, longest first."""
    values = {env.get(name, "") for name in SECRET_ENV}
    try:
        password = urlsplit(env.get("DATABASE_URL", "")).password or ""
    except ValueError:
        password = ""
    values.update({password, unquote(password)})
    return sorted((v for v in values if v), key=len, reverse=True)


def redact(text: str, secrets: Iterable[str]) -> str:
    for secret in secrets:
        text = text.replace(secret, "[redacted]")
    return text


# ---------------------------------------------------------------------------
# Real S3 / Postgres adapters. boto3 and psycopg are passed in, never imported
# at module level.
# ---------------------------------------------------------------------------


def make_list_objects_fn(s3_client, bucket: str) -> Callable[[str], list[dict]]:
    """Return a function listing every object under one prefix (ListObjectsV2, paginated)."""

    def list_objects(prefix: str) -> list[dict]:
        paginator = s3_client.get_paginator("list_objects_v2")
        objects: list[dict] = []
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                objects.append({"Key": obj["Key"], "LastModified": obj["LastModified"]})
        return objects

    return list_objects


def make_list_root_prefixes_fn(s3_client, bucket: str) -> Callable[[], list[str]]:
    """Return a function listing the bucket's top-level prefixes (delimiter "/")."""

    def list_root_prefixes() -> list[str]:
        paginator = s3_client.get_paginator("list_objects_v2")
        prefixes: list[str] = []
        for page in paginator.paginate(Bucket=bucket, Prefix="", Delimiter="/"):
            prefixes.extend(entry["Prefix"] for entry in page.get("CommonPrefixes", []))
        return prefixes

    return list_root_prefixes


def make_delete_fn(s3_client, bucket: str) -> Callable[[list[str]], list[dict]]:
    """Return a function calling DeleteObjects for one batch and returning per-key errors."""

    def delete_objects(keys: list[str]) -> list[dict]:
        response = s3_client.delete_objects(
            Bucket=bucket,
            Delete={"Objects": [{"Key": key} for key in keys], "Quiet": True},
        )
        return [
            {"Key": e["Key"], "Code": e.get("Code", ""), "Message": e.get("Message", "")}
            for e in response.get("Errors", [])
        ]

    return delete_objects


def make_query_fn(conn) -> Callable[[str], list[str]]:
    """Return a function running one SELECT and returning its first column."""

    def query(sql: str) -> list[str]:
        with conn.cursor() as cur:
            cur.execute(sql)
            return [row[0] for row in cur.fetchall()]

    return query


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _non_negative_int(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must be zero or more")
    return number


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Delete bucket image objects that no Postgres row references. Dry run unless --apply is given."
    )
    parser.add_argument("--apply", action="store_true", help="delete orphans (default: dry run)")
    parser.add_argument(
        "--min-age-minutes",
        type=_non_negative_int,
        default=DEFAULT_MIN_AGE_MINUTES,
        metavar="N",
        help=f"only objects last modified more than N minutes ago can be orphans (default {DEFAULT_MIN_AGE_MINUTES})",
    )
    return parser.parse_args(argv)


def run(
    args: argparse.Namespace,
    env: Mapping[str, str],
    secrets: list[str],
    *,
    now: datetime | None = None,
) -> int:
    # Imported here so the core logic above needs neither package.
    import boto3  # noqa: PLC0415
    import psycopg  # noqa: PLC0415

    bucket = env["AWS_S3_BUCKET_NAME"]
    client_options: dict = {}
    if env.get("S3_FORCE_PATH_STYLE", "").strip().lower() in {"1", "true", "yes"}:
        from botocore.config import Config  # noqa: PLC0415

        client_options["config"] = Config(s3={"addressing_style": "path"})
    s3 = boto3.client(
        "s3",
        region_name=env["AWS_DEFAULT_REGION"],
        endpoint_url=env["AWS_ENDPOINT_URL"],
        aws_access_key_id=env["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=env["AWS_SECRET_ACCESS_KEY"],
        **client_options,
    )

    print("Reading referenced keys from Postgres...")
    with psycopg.connect(env["DATABASE_URL"]) as conn:
        referenced = collect_referenced_keys(make_query_fn(conn))
    print(f"  Referenced keys: {len(referenced)}")

    prefixes = managed_prefixes(make_list_root_prefixes_fn(s3, bucket)())
    print(f"Listing bucket prefixes: {', '.join(prefixes)}")
    current = now if now is not None else datetime.now(tz=timezone.utc)
    bucket_objects = collect_bucket_keys(
        make_list_objects_fn(s3, bucket),
        prefixes,
        min_age_minutes=args.min_age_minutes,
        cutoff=current - timedelta(minutes=args.min_age_minutes),
    )
    print(f"  Objects last modified more than {args.min_age_minutes} min ago: {len(bucket_objects)}")
    orphans = find_orphans(bucket_objects, referenced)
    print(f"  Orphans: {len(orphans)}")

    if not orphans:
        print("No orphans found. Nothing to do.")
        return 0

    if not args.apply:
        print("\nDRY RUN: nothing deleted. Re-run with --apply to delete.")
        print(f"Sample orphan keys (up to {DRY_RUN_SAMPLE}):")
        for obj in orphans[:DRY_RUN_SAMPLE]:
            print(f"  {obj['Key']}")
        if len(orphans) > DRY_RUN_SAMPLE:
            print(f"  ... and {len(orphans) - DRY_RUN_SAMPLE} more")
        return 0

    print(f"\nDeleting {len(orphans)} object(s) in batches of {DELETE_BATCH_SIZE}...")
    deleted, errors = delete_in_batches(
        make_delete_fn(s3, bucket), [obj["Key"] for obj in orphans]
    )
    print(f"Deleted: {deleted}")
    if errors:
        print(f"Errors: {len(errors)}", file=sys.stderr)
        for err in errors:
            message = redact(f"{err['Code']}: {err['Message']}", secrets)
            print(f"  {err['Key']}: {message}", file=sys.stderr)
        return 1

    print("Done.")
    return 0


def main(argv: list[str] | None = None, *, now: datetime | None = None) -> int:
    """Entry point. ``now`` is injected by tests; production uses the real clock."""
    args = parse_args(argv)
    env = dict(os.environ)

    missing = [name for name in REQUIRED_ENV if not env.get(name, "").strip()]
    if missing:
        print(f"Error: missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        return 2

    secrets = secret_values(env)
    try:
        return run(args, env, secrets, now=now)
    except ImportError as exc:
        print(
            "Error: boto3 and psycopg are required; run with "
            f"uv run --with boto3 --with 'psycopg[binary]': {redact(str(exc), secrets)}",
            file=sys.stderr,
        )
        return 2
    except Exception as exc:  # report the failure without echoing configuration values
        print(f"Error: {type(exc).__name__}: {redact(str(exc), secrets)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
