#!/usr/bin/env python3
"""Sample an already warmed, transient worker's idle CPU/RSS/VRAM. No startup.
Run through ~/.cache/taphoa-mini/heavy. Does not touch services or model files.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def sample(pid):
    stat = Path(f"/proc/{pid}/stat").read_text().split()
    cpu = (int(stat[13]) + int(stat[14])) / os.sysconf("SC_CLK_TCK")
    rss = int(next(line.split()[1] for line in Path(f"/proc/{pid}/status").read_text().splitlines() if line.startswith("VmRSS:")))
    rows = subprocess.check_output(["nvidia-smi", "--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"], text=True)
    vram = sum(int(row.split(",")[1]) for row in rows.splitlines() if int(row.split(",")[0]) == pid)
    return {"cpu_seconds": cpu, "rss_kib": rss, "vram_mib": vram}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pid", type=int)
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    start = time.monotonic()
    before = sample(args.pid)
    time.sleep(args.seconds)
    after = sample(args.pid)
    elapsed = time.monotonic() - start
    result = {"pid": args.pid, "elapsed_seconds": elapsed, "before": before, "after": after, "idle_cpu_seconds": after["cpu_seconds"]-before["cpu_seconds"], "idle_cpu_percent": (after["cpu_seconds"]-before["cpu_seconds"])/elapsed*100, "load_1m": os.getloadavg()[0]}
    args.output.write_text(json.dumps(result, indent=2)+"\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
