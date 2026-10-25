"""Tests for delete_orphan_images.py.

Run from the repository root. No network, database or bucket is used, and boto3,
psycopg and botocore are not needed:

    python3 -I scripts/ops/test_delete_orphan_images.py -v
    python3 -I -m unittest discover -s scripts/ops -v

The module is loaded from its file path. main() gets fake boto3, psycopg and botocore
modules through sys.modules, so nothing is imported from site-packages.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import subprocess
import sys
import types
import unittest
from collections import namedtuple
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

_MODULE_PATH = Path(__file__).resolve().parent / "delete_orphan_images.py"
_spec = importlib.util.spec_from_file_location("delete_orphan_images", _MODULE_PATH)
ops = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ops)

BUCKET = "taphoa-test-bucket"
NOW = datetime(2026, 10, 25, 8, 0, 0, tzinfo=timezone.utc)
OLD = NOW - timedelta(hours=2)
FRESH = NOW - timedelta(minutes=5)
CUTOFF = NOW - timedelta(minutes=60)

DATABASE_URL = "postgres://app:hunter2@db.internal:5432/taphoa"
ENDPOINT = "https://storage.example.test"
SECRET_KEY = "s3cr3t-test-value"
ACCESS_KEY = "AKIATESTKEYID"

BASE_ENV = {
    "DATABASE_URL": DATABASE_URL,
    "AWS_ENDPOINT_URL": ENDPOINT,
    "AWS_ACCESS_KEY_ID": ACCESS_KEY,
    "AWS_SECRET_ACCESS_KEY": SECRET_KEY,
    "AWS_S3_BUCKET_NAME": BUCKET,
    "AWS_DEFAULT_REGION": "auto",
}
SECRET_FRAGMENTS = ("hunter2", SECRET_KEY, ACCESS_KEY, "storage.example.test", "db.internal")

ORPHAN = "images/2026/10/orphan.jpg"
KEPT = "images/2026/10/kept.jpg"
CUTOUT_ORPHAN = "20261025/9f1c2d3e-0000-4000-8000-000000000001.jpg"
CUTOUT_KEPT = "20261025/9f1c2d3e-0000-4000-8000-000000000002.jpg"


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeS3:
    """In-memory stand-in for the boto3 S3 client, limited to what the script calls."""

    def __init__(
        self,
        objects: dict[str, datetime],
        *,
        page_size: int = 1000,
        fail: dict[str, tuple[str, str]] | None = None,
        list_error: Exception | None = None,
    ):
        self.objects = dict(objects)
        self.page_size = page_size
        self.fail = fail or {}
        self.list_error = list_error
        self.delete_batches: list[list[str]] = []
        self.list_calls: list[tuple[str, str | None]] = []

    def get_paginator(self, operation: str):
        assert operation == "list_objects_v2", operation
        return _Paginator(self)

    def delete_objects(self, *, Bucket: str, Delete: dict):
        assert Bucket == BUCKET, Bucket
        keys = [entry["Key"] for entry in Delete["Objects"]]
        if len(keys) > 1000:
            raise ValueError("DeleteObjects accepts at most 1000 keys")
        self.delete_batches.append(keys)
        errors = []
        for key in keys:
            if key in self.fail:
                code, message = self.fail[key]
                errors.append({"Key": key, "Code": code, "Message": message})
            else:
                self.objects.pop(key, None)
        return {"Errors": errors}


class _Paginator:
    def __init__(self, s3: FakeS3):
        self._s3 = s3

    def paginate(self, *, Bucket: str, Prefix: str = "", Delimiter: str | None = None):
        s3 = self._s3
        assert Bucket == BUCKET, Bucket
        s3.list_calls.append((Prefix, Delimiter))
        if s3.list_error is not None:
            raise s3.list_error
        keys = sorted(k for k in s3.objects if k.startswith(Prefix))
        if Delimiter is None:
            size = s3.page_size
            chunks = [keys[i : i + size] for i in range(0, len(keys), size)] or [[]]
            return [
                {"Contents": [{"Key": k, "LastModified": s3.objects[k]} for k in chunk]}
                for chunk in chunks
            ]
        # Delimiter listing: one page, folders as CommonPrefixes, direct keys as Contents.
        folders = sorted(
            {Prefix + k[len(Prefix) :].split("/", 1)[0] + "/" for k in keys if "/" in k[len(Prefix) :]}
        )
        direct = [k for k in keys if "/" not in k[len(Prefix) :]]
        return [
            {
                "CommonPrefixes": [{"Prefix": p} for p in folders],
                "Contents": [{"Key": k, "LastModified": s3.objects[k]} for k in direct],
            }
        ]


class _FakeCursor:
    def __init__(self, rows: list[str], log: list[str]):
        self._rows = rows
        self._log = log
        self._result: list[tuple] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql: str):
        self._log.append(sql)
        allowed = {ops.referenced_key_sql(t, c) for t, c in ops.REFERENCED_KEY_COLUMNS}
        assert sql in allowed, f"unexpected query: {sql}"
        self._result = [(row,) for row in self._rows]

    def fetchall(self):
        return self._result


class _FakeConnection:
    def __init__(self, rows: list[str], log: list[str]):
        self._rows = rows
        self._log = log

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return _FakeCursor(self._rows, self._log)


class _FakeConfig:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


def _module(name: str, **attrs) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    return module


Run = namedtuple("Run", "rc out err client_calls queries")


def run_main(
    argv: list[str],
    *,
    s3: FakeS3,
    referenced: list[str] | tuple[str, ...] = (),
    env: dict[str, str] | None = None,
    connect_error: Exception | None = None,
) -> Run:
    client_calls: list[dict] = []
    queries: list[str] = []

    def client(service: str, **kwargs):
        assert service == "s3", service
        client_calls.append({"service": service, **kwargs})
        return s3

    def connect(url: str):
        assert url == DATABASE_URL, "connect() must receive DATABASE_URL"
        if connect_error is not None:
            raise connect_error
        return _FakeConnection(list(referenced), queries)

    config_module = _module("botocore.config", Config=_FakeConfig)
    modules = {
        "boto3": _module("boto3", client=client),
        "psycopg": _module("psycopg", connect=connect),
        "botocore": _module("botocore", config=config_module),
        "botocore.config": config_module,
    }
    out, err = io.StringIO(), io.StringIO()
    with (
        patch.dict("os.environ", BASE_ENV if env is None else env, clear=True),
        patch.dict(sys.modules, modules),
        contextlib.redirect_stdout(out),
        contextlib.redirect_stderr(err),
    ):
        rc = ops.main(argv)
    return Run(rc, out.getvalue(), err.getvalue(), client_calls, queries)


def sample_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.startswith("  images/") or line.startswith("  20")]


# ---------------------------------------------------------------------------
# Schema constants
# ---------------------------------------------------------------------------


class TestSchema(unittest.TestCase):
    def test_images_object_key_is_a_referenced_column(self):
        self.assertIn(("images", "object_key"), ops.REFERENCED_KEY_COLUMNS)

    def test_managed_prefixes_are_images_plus_cutout_folders_only(self):
        roots = ["images/", "20261025/", "2026-10-25/", "202610251/", "other/", "loose.jpg"]
        self.assertEqual(ops.managed_prefixes(roots), ["images/", "20261025/"])

    def test_managed_prefixes_without_cutouts(self):
        self.assertEqual(ops.managed_prefixes(["images/", "other/"]), ["images/"])


# ---------------------------------------------------------------------------
# Referenced keys
# ---------------------------------------------------------------------------


class TestCollectReferencedKeys(unittest.TestCase):
    def test_queries_each_column_and_unions_results(self):
        seen: list[str] = []

        def query(sql: str) -> list[str]:
            seen.append(sql)
            return [KEPT, KEPT, "images/2026/10/other.png"]

        result = ops.collect_referenced_keys(query)
        self.assertEqual(seen, [ops.referenced_key_sql(t, c) for t, c in ops.REFERENCED_KEY_COLUMNS])
        self.assertEqual(result, {KEPT, "images/2026/10/other.png"})

    def test_no_rows_gives_empty_set(self):
        self.assertEqual(ops.collect_referenced_keys(lambda sql: []), set())


# ---------------------------------------------------------------------------
# Bucket listing: prefixes, age gate, pagination, cutout folders
# ---------------------------------------------------------------------------


class TestCollectBucketKeys(unittest.TestCase):
    def test_lists_only_requested_prefixes(self):
        requested: list[str] = []

        def list_fn(prefix: str) -> list[dict]:
            requested.append(prefix)
            if prefix == "images/":
                return [{"Key": KEPT, "LastModified": OLD}]
            # A misbehaving listing returning a key outside its prefix must be dropped.
            return [{"Key": "other/outside.dat", "LastModified": OLD}]

        result = ops.collect_bucket_keys(
            list_fn, ["images/", "20261025/"], min_age_minutes=60, cutoff=CUTOFF
        )
        self.assertEqual(requested, ["images/", "20261025/"])
        self.assertEqual([o["Key"] for o in result], [KEPT])

    def test_too_new_and_exact_cutoff_are_excluded(self):
        objects = [
            {"Key": "images/a.jpg", "LastModified": CUTOFF - timedelta(seconds=1)},
            {"Key": "images/b.jpg", "LastModified": CUTOFF},
            {"Key": "images/c.jpg", "LastModified": FRESH},
        ]
        result = ops.collect_bucket_keys(lambda p: objects, ["images/"], min_age_minutes=60, cutoff=CUTOFF)
        self.assertEqual([o["Key"] for o in result], ["images/a.jpg"])

    def test_naive_last_modified_is_treated_as_utc(self):
        naive = (OLD).replace(tzinfo=None)
        result = ops.collect_bucket_keys(
            lambda p: [{"Key": "images/n.jpg", "LastModified": naive}],
            ["images/"],
            min_age_minutes=60,
            cutoff=CUTOFF,
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["LastModified"].tzinfo, timezone.utc)

    def test_folder_markers_are_skipped(self):
        result = ops.collect_bucket_keys(
            lambda p: [{"Key": "images/", "LastModified": OLD}],
            ["images/"],
            min_age_minutes=60,
            cutoff=CUTOFF,
        )
        self.assertEqual(result, [])

    def test_paginated_listing_is_merged(self):
        keys = {f"images/2026/10/{i:02d}.jpg": OLD for i in range(5)}
        s3 = FakeS3(keys, page_size=2)
        result = ops.collect_bucket_keys(
            ops.make_list_objects_fn(s3, BUCKET), ["images/"], min_age_minutes=60, cutoff=CUTOFF
        )
        self.assertEqual(sorted(o["Key"] for o in result), sorted(keys))

    def test_root_prefixes_found_by_delimiter(self):
        s3 = FakeS3(
            {
                CUTOUT_KEPT: OLD,
                KEPT: OLD,
                "loose.jpg": OLD,
                "other/outside.dat": OLD,
            }
        )
        roots = ops.make_list_root_prefixes_fn(s3, BUCKET)()
        self.assertEqual(sorted(roots), ["20261025/", "images/", "other/"])
        self.assertEqual(ops.managed_prefixes(roots), ["images/", "20261025/"])


# ---------------------------------------------------------------------------
# Orphans and batched deletes
# ---------------------------------------------------------------------------


class TestFindOrphans(unittest.TestCase):
    def test_referenced_key_is_not_an_orphan(self):
        bucket = [{"Key": KEPT, "LastModified": OLD}]
        self.assertEqual(ops.find_orphans(bucket, {KEPT}), [])

    def test_unreferenced_key_is_an_orphan(self):
        bucket = [{"Key": KEPT, "LastModified": OLD}, {"Key": ORPHAN, "LastModified": OLD}]
        self.assertEqual([o["Key"] for o in ops.find_orphans(bucket, {KEPT})], [ORPHAN])

    def test_orphans_sorted_by_key(self):
        bucket = [{"Key": "images/b.jpg", "LastModified": OLD}, {"Key": "images/a.jpg", "LastModified": OLD}]
        self.assertEqual([o["Key"] for o in ops.find_orphans(bucket, set())], ["images/a.jpg", "images/b.jpg"])


class TestDeleteInBatches(unittest.TestCase):
    def test_no_keys_means_no_call(self):
        calls: list[list[str]] = []
        self.assertEqual(ops.delete_in_batches(lambda b: calls.append(b) or [], []), (0, []))
        self.assertEqual(calls, [])

    def test_splits_into_batches_of_1000(self):
        total = ops.DELETE_BATCH_SIZE + 3
        keys = [f"images/2026/10/{i}.jpg" for i in range(total)]
        sizes: list[int] = []
        deleted, errors = ops.delete_in_batches(lambda b: sizes.append(len(b)) or [], keys)
        self.assertEqual((deleted, errors), (total, []))
        self.assertEqual(sizes, [1000, 3])

    def test_per_key_errors_are_collected(self):
        keys = ["images/a.jpg", "images/b.jpg"]
        deleted, errors = ops.delete_in_batches(
            lambda b: [{"Key": "images/a.jpg", "Code": "AccessDenied", "Message": "no"}], keys
        )
        self.assertEqual(deleted, 1)
        self.assertEqual([e["Key"] for e in errors], ["images/a.jpg"])

    def test_errors_across_batches_accumulate(self):
        keys = [f"images/{i}.jpg" for i in range(ops.DELETE_BATCH_SIZE + 1)]
        deleted, errors = ops.delete_in_batches(
            lambda b: [{"Key": b[0], "Code": "E", "Message": "m"}], keys
        )
        self.assertEqual(len(errors), 2)
        self.assertEqual(deleted, len(keys) - 2)


# ---------------------------------------------------------------------------
# main(): dry run, apply, exit codes, secrets
# ---------------------------------------------------------------------------


class TestMainDryRun(unittest.TestCase):
    def test_dry_run_deletes_nothing_and_shows_orphan_sample(self):
        s3 = FakeS3({ORPHAN: OLD, KEPT: OLD})
        run = run_main([], s3=s3, referenced=[KEPT])
        self.assertEqual(run.rc, 0)
        self.assertIn("DRY RUN", run.out)
        self.assertEqual(s3.delete_batches, [])
        self.assertEqual(set(s3.objects), {ORPHAN, KEPT})
        self.assertIn(f"  {ORPHAN}", run.out)
        self.assertNotIn(f"  {KEPT}", run.out)

    def test_dry_run_samples_at_most_20_keys(self):
        objects = {f"images/2026/10/o{i:02d}.jpg": OLD for i in range(25)}
        run = run_main([], s3=FakeS3(objects))
        self.assertEqual(run.rc, 0)
        self.assertEqual(len(sample_lines(run.out)), ops.DRY_RUN_SAMPLE)
        self.assertIn("... and 5 more", run.out)

    def test_no_orphans_exits_0(self):
        run = run_main([], s3=FakeS3({KEPT: OLD}), referenced=[KEPT])
        self.assertEqual(run.rc, 0)
        self.assertIn("No orphans found", run.out)


class TestMainApply(unittest.TestCase):
    def test_apply_deletes_only_old_unreferenced_objects_under_managed_prefixes(self):
        s3 = FakeS3(
            {
                KEPT: OLD,  # referenced
                ORPHAN: OLD,  # deleted
                "images/2026/10/inflight.jpg": FRESH,  # too new
                CUTOUT_ORPHAN: OLD,  # cutout folder, unreferenced: deleted
                CUTOUT_KEPT: OLD,  # cutout folder, referenced
                "other/outside.dat": OLD,  # outside managed prefixes
                "loose.jpg": OLD,  # bucket root, not a cutout folder
            }
        )
        run = run_main(["--apply"], s3=s3, referenced=[KEPT, CUTOUT_KEPT])
        self.assertEqual(run.rc, 0, run.err)
        self.assertEqual(sorted(k for batch in s3.delete_batches for k in batch), sorted([ORPHAN, CUTOUT_ORPHAN]))
        self.assertEqual(
            set(s3.objects),
            {KEPT, "images/2026/10/inflight.jpg", CUTOUT_KEPT, "other/outside.dat", "loose.jpg"},
        )
        listed = {prefix for prefix, delimiter in s3.list_calls if delimiter is None}
        self.assertEqual(listed, {"images/", "20261025/"})
        self.assertIn("Deleted: 2", run.out)

    def test_too_new_object_is_kept_even_with_apply(self):
        s3 = FakeS3({"images/2026/10/inflight.jpg": FRESH})
        run = run_main(["--apply", "--min-age-minutes", "60"], s3=s3)
        self.assertEqual(run.rc, 0)
        self.assertEqual(s3.delete_batches, [])
        self.assertIn("images/2026/10/inflight.jpg", s3.objects)

    def test_apply_batches_deletes_by_1000(self):
        total = ops.DELETE_BATCH_SIZE + 3
        objects = {f"images/2026/10/o{i:04d}.jpg": OLD for i in range(total)}
        s3 = FakeS3(objects, page_size=500)
        run = run_main(["--apply"], s3=s3)
        self.assertEqual(run.rc, 0, run.err)
        self.assertEqual([len(b) for b in s3.delete_batches], [1000, 3])
        self.assertIn(f"Deleted: {total}", run.out)

    def test_per_key_error_exits_1_and_reports_key(self):
        s3 = FakeS3(
            {"images/2026/10/a.jpg": OLD, "images/2026/10/b.jpg": OLD},
            fail={"images/2026/10/b.jpg": ("AccessDenied", "Access Denied")},
        )
        run = run_main(["--apply"], s3=s3)
        self.assertEqual(run.rc, 1)
        self.assertIn("Deleted: 1", run.out)
        self.assertIn("images/2026/10/b.jpg", run.err)
        self.assertIn("AccessDenied", run.err)
        self.assertEqual(set(s3.objects), {"images/2026/10/b.jpg"})


class TestMainOptionsAndConfig(unittest.TestCase):
    def test_missing_env_exits_2_and_names_only_variables(self):
        env = {k: v for k, v in BASE_ENV.items() if k != "AWS_S3_BUCKET_NAME"}
        run = run_main([], s3=FakeS3({}), env=env)
        self.assertEqual(run.rc, 2)
        self.assertIn("AWS_S3_BUCKET_NAME", run.err)
        self.assertFalse(any(fragment in run.err for fragment in SECRET_FRAGMENTS))

    def test_negative_min_age_is_rejected_by_argparse(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
            ops.parse_args(["--min-age-minutes", "-1"])
        self.assertEqual(ctx.exception.code, 2)

    def test_default_client_has_no_path_style_config(self):
        run = run_main([], s3=FakeS3({}))
        self.assertNotIn("config", run.client_calls[0])

    def test_force_path_style_sets_addressing_style(self):
        env = {**BASE_ENV, "S3_FORCE_PATH_STYLE": "true"}
        run = run_main([], s3=FakeS3({}), env=env)
        self.assertEqual(run.rc, 0, run.err)
        self.assertEqual(run.client_calls[0]["config"].kwargs, {"s3": {"addressing_style": "path"}})

    def test_module_imports_without_third_party_packages(self):
        code = (
            "import importlib.util, sys\n"
            f"spec = importlib.util.spec_from_file_location('m', {str(_MODULE_PATH)!r})\n"
            "mod = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(mod)\n"
            "assert 'boto3' not in sys.modules and 'psycopg' not in sys.modules\n"
            "print('ok')\n"
        )
        result = subprocess.run(
            [sys.executable, "-I", "-c", code], capture_output=True, text=True, check=False
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ok")


class TestSecretsNeverPrinted(unittest.TestCase):
    def _assert_clean(self, run: Run):
        combined = run.out + run.err
        for fragment in SECRET_FRAGMENTS:
            self.assertNotIn(fragment, combined)

    def test_success_output_has_no_secrets(self):
        s3 = FakeS3({ORPHAN: OLD})
        self._assert_clean(run_main([], s3=s3))
        self._assert_clean(run_main(["--apply"], s3=FakeS3({ORPHAN: OLD})))

    def test_database_error_text_is_redacted(self):
        run = run_main([], s3=FakeS3({}), connect_error=RuntimeError(f"could not connect to {DATABASE_URL}"))
        self.assertEqual(run.rc, 1)
        self.assertIn("RuntimeError", run.err)
        self._assert_clean(run)

    def test_listing_error_text_is_redacted(self):
        s3 = FakeS3({}, list_error=RuntimeError(f"cannot reach {ENDPOINT} with key {ACCESS_KEY}"))
        run = run_main([], s3=s3)
        self.assertEqual(run.rc, 1)
        self._assert_clean(run)

    def test_delete_error_text_is_redacted(self):
        s3 = FakeS3(
            {ORPHAN: OLD},
            fail={ORPHAN: ("AccessDenied", f"denied at {ENDPOINT} for {SECRET_KEY}")},
        )
        run = run_main(["--apply"], s3=s3)
        self.assertEqual(run.rc, 1)
        self.assertIn("AccessDenied", run.err)
        self._assert_clean(run)


if __name__ == "__main__":
    unittest.main()
