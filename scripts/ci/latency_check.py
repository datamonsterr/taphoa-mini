"""p95 latency check: latency_check.py <base-url> <path> <samples> <max-p95-ms>

Issues sequential GETs after one warm-up request, prints min/p50/p95/max in ms and
exits 1 when p95 exceeds the budget.
"""

import math
import sys
import time
import urllib.request


def sample(url):
    start = time.perf_counter()
    with urllib.request.urlopen(url, timeout=30) as response:
        response.read()
        if response.status != 200:
            raise RuntimeError(f"{url} returned {response.status}")
    return (time.perf_counter() - start) * 1000


def main(argv):
    if len(argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    base, path, samples, budget = argv[1].rstrip("/"), argv[2], int(argv[3]), float(argv[4])
    url = base + path
    sample(url)  # warm-up: TLS, connection, lazy caches
    times = sorted(sample(url) for _ in range(samples))
    p95 = times[min(len(times) - 1, math.ceil(0.95 * len(times)) - 1)]
    print(
        f"GET {path}: n={samples} min={times[0]:.0f}ms p50={times[len(times) // 2]:.0f}ms "
        f"p95={p95:.0f}ms max={times[-1]:.0f}ms (budget p95 <= {budget:.0f}ms)"
    )
    if p95 > budget:
        print(f"::error::p95 {p95:.0f}ms for {path} exceeds {budget:.0f}ms", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
