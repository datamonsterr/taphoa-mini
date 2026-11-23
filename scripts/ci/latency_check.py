"""p95 latency check: latency_check.py <base-url> <path> <samples> <max-p95-ms>

Issues sequential GETs over one persistent connection after one warm-up request (which
pays for DNS, TCP, TLS and lazy caches), prints min/p50/p95/max in ms and exits 1 when
p95 exceeds the budget.
"""

import math
import sys
import time
import http.client
import urllib.parse


def connect(base):
    parts = urllib.parse.urlsplit(base)
    cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    return cls(parts.netloc, timeout=30)


def sample(conn, path):
    start = time.perf_counter()
    conn.request("GET", path)
    response = conn.getresponse()
    response.read()
    if response.status != 200:
        raise RuntimeError(f"{path} returned {response.status}")
    return (time.perf_counter() - start) * 1000


def main(argv):
    if len(argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    base, path, samples, budget = argv[1].rstrip("/"), argv[2], int(argv[3]), float(argv[4])
    conn = connect(base)
    sample(conn, path)  # warm-up: TLS, connection, lazy caches
    times = sorted(sample(conn, path) for _ in range(samples))
    conn.close()
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
