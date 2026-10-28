#!/usr/bin/env python3
"""Summarize a controlled recognition run; see recognition-evidence.md beside this file."""
import argparse
import json
import math
import re
from pathlib import Path


def scan_fields(line):
    line = re.sub(r"\x1b\[[0-9;]*m", "", line)
    try:
        record = json.loads(line)
        fields = record.get("fields", record)
        # Railway --json wraps the application's log in message.
        if "recognition scan complete" not in str(fields.get("message", "")):
            return None
        if "scan_id" not in fields:
            return scan_fields(fields["message"])
        return fields
    except json.JSONDecodeError:
        if "recognition scan complete" not in line:
            return None
        return dict(re.findall(r"\b(scan_id|segment_ms|embed_ms|total_ms)=\"?([\w.-]+)", line))


def summarize(logs, objects, cpu_seconds=None):
    scans = {}
    for line in logs.splitlines():
        fields = scan_fields(line)
        if fields:
            scan_id = fields["scan_id"]
            for key in ("segment_ms", "embed_ms", "total_ms"):
                value = float(fields[key])
                if not math.isfinite(value) or value < 0:
                    raise ValueError(f"invalid {key} for {scan_id}")
            scans[scan_id] = fields
    if not scans:
        raise ValueError("no recognition scan complete records found")
    sizes = {}
    covered = set()
    for item in objects:
        if item["scan_id"] not in scans:
            continue
        key, size = item["object_key"], item["bytes"]
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ValueError("object bytes must be nonnegative integers")
        if key in sizes and sizes[key] != size:
            raise ValueError(f"inconsistent size for {key}")
        sizes[key] = size
        covered.add(item["scan_id"])
    if covered != set(scans):
        raise ValueError("object inventory must cover every logged scan")
    if cpu_seconds is not None and (not math.isfinite(cpu_seconds) or cpu_seconds < 0):
        raise ValueError("CPU seconds must be finite and nonnegative")
    count = len(scans)
    return {
        "scans": count,
        "inference_wall_seconds_per_scan": sum(
            float(s["segment_ms"]) + float(s["embed_ms"]) for s in scans.values()
        ) / 1000 / count,
        "request_wall_seconds_per_scan": sum(float(s["total_ms"]) for s in scans.values()) / 1000 / count,
        "cpu_seconds_per_scan": None if cpu_seconds is None else cpu_seconds / count,
        "cpu_note": "CPU metric delta for the same isolated workload window required; stage timings are wall time.",
        "unique_storage_objects": len(sizes),
        "storage_bytes": sum(sizes.values()),
        "storage_bytes_per_scan": sum(sizes.values()) / count,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--logs", required=True, type=Path)
    parser.add_argument("--objects", required=True, type=Path, help="JSONL: scan_id, object_key, bytes")
    parser.add_argument("--cpu-seconds", type=float, help="measured CPU counter delta over this workload")
    args = parser.parse_args()
    try:
        objects = [json.loads(line) for line in args.objects.read_text().splitlines() if line.strip()]
        print(json.dumps(summarize(args.logs.read_text(), objects, args.cpu_seconds), indent=2))
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
