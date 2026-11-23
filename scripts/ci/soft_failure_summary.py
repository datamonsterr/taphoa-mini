"""Write a red job-summary entry for a failed soft e2e group: soft_failure_summary.py <log>.

Keeps the latency statistics and assertion lines from the vitest log so the failure is visible
on the run page even though the step stays green. Appends to $GITHUB_STEP_SUMMARY, else stdout.
"""

import os
import re
import sys

MAX_LINES = 40
KEEP = re.compile(r"p9\d=|latency ms:|must be <|AssertionError|^\s*(FAIL|×)\s")


def main(argv):
    try:
        with open(argv[1], encoding="utf-8", errors="replace") as handle:
            lines = [line.strip() for line in handle if KEEP.search(line)]
    except (IndexError, OSError):
        lines = []
    out = ["### :red_circle: Deploy e2e soft group failed", ""]
    out.append(
        "Latency or live-model specs failed on the test environment. The job stays green "
        "(non-blocking) unless E2E_SOFT_STRICT=1."
    )
    out.append("")
    if lines:
        out.append("```")
        out.extend(lines[:MAX_LINES])
        if len(lines) > MAX_LINES:
            out.append(f"... {len(lines) - MAX_LINES} more lines in the step log")
        out.append("```")
    else:
        out.append("no latency lines captured; see the step log")
    text = "\n".join(out) + "\n\n"
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if target:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
