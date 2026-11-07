#!/usr/bin/env python3
"""Remove abandoned integration databases and warn about Postgres database sizes."""

import json
import os
import re
import subprocess
import sys
import time


NEW_NAME = re.compile(r"^it_(\d+)_[A-Za-z0-9]+_\d+_\d+$")


def stale_databases(names, now, max_age_hours):
    cutoff = now - max_age_hours * 3600
    stale = []
    for name in names:
        if not name.startswith("it_"):
            continue
        match = NEW_NAME.fullmatch(name)
        if not match or int(match.group(1)) < cutoff:
            stale.append(name)
    return stale


def size_warning(sizes, limit):
    total = sum(size for _, size in sizes)
    if total <= limit:
        return None
    largest = sorted(sizes, key=lambda item: item[1], reverse=True)[:5]
    details = ", ".join(f"{name}: {size} bytes" for name, size in largest)
    # GitHub workflow annotations must remain on one line.
    details = details.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    return f"::warning::Postgres databases total {total} bytes (limit {limit}); largest: {details}"


def query(url, sql):
    return subprocess.run(
        ["psql", url, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
        check=True, text=True, capture_output=True,
    ).stdout.strip()


def main():
    age = float(os.environ.get("IT_DB_MAX_AGE_HOURS", "6"))
    limit = int(os.environ.get("IT_DB_SIZE_LIMIT_BYTES", "3500000000"))
    if not 0 < age < float("inf") or limit < 0:
        raise ValueError("IT_DB_MAX_AGE_HOURS must be positive and IT_DB_SIZE_LIMIT_BYTES nonnegative")
    url = os.environ["DATABASE_URL"]
    names = json.loads(query(url, "SELECT COALESCE(json_agg(datname), '[]'::json) FROM pg_database"))
    for name in stale_databases(names, time.time(), age):
        identifier = '"' + name.replace('"', '""') + '"'
        query(url, f"DROP DATABASE {identifier} WITH (FORCE)")
        print(f"Dropped stale integration database {name!r}", flush=True)
    sizes = json.loads(query(url, "SELECT COALESCE(json_agg(json_build_array(datname, pg_database_size(oid))), '[]'::json) FROM pg_database"))
    warning = size_warning(sizes, limit)
    if warning:
        print(warning, flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, subprocess.CalledProcessError) as exc:
        print(f"Integration database maintenance failed: {exc}", file=sys.stderr)
        sys.exit(1)
