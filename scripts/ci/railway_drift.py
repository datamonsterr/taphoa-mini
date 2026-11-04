"""Fail when Railway's live backend variables differ from `.railway/railway.ts`.

Usage: railway_drift.py [environment]

Runs `railway config plan --detailed-exit-code` (read-only; never applies) and keeps only the
`backend` variable lines. The plan covers the whole project (volumes, buckets, source), which
has separate known drift, so those lines are ignored here. Only variable NAMES are printed:
the plan is redacted by default and this script never passes `--show-values`, and the raw plan
is never echoed, so `preserve()`d secrets cannot reach the job log.

Exit 0 no backend variable drift, 1 drift (names listed), 2 the plan itself failed.
"""

import os
import re
import shutil
import subprocess
import sys

VARIABLE_LINE = re.compile(
    r"^\s*[+~-]\s+(?P<action>Set|Update|Delete)\s+variables?\s+backend\.(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*$"
)
VERB = {"Set": "set", "Update": "change", "Delete": "delete"}


def parse_plan(text):
    """Return sorted (name, action) pairs for backend variable changes in a plan."""
    found = {}
    for line in text.splitlines():
        match = VARIABLE_LINE.match(line)
        if match:
            found[match["name"]] = VERB[match["action"]]
    return sorted(found.items())


def plan(environment):
    cmd = ["railway", "config", "plan", "--detailed-exit-code"]
    if environment:
        cmd += ["--environment", environment]
    # The railway/iac SDK checks the CLI version by running `$_ --version`. Under `python3 script.py`
    # the shell sets `_` to python3, which reads as version 3.x and aborts the plan.
    env = {**os.environ, "_": shutil.which("railway") or "railway"}
    return subprocess.run(cmd, capture_output=True, text=True, check=False, env=env)


def report(drift, environment):
    label = environment or "linked environment"
    lines = [f"::error::Railway {label} backend variables drifted from .railway/railway.ts:"]
    lines += [f"  - {name}: the plan would {action} it" for name, action in drift]
    lines += [
        "A human must reconcile it: edit .railway/railway.ts to match Railway, or run",
        "`railway config plan` and `railway config apply` (the plan is project-wide; review it",
        "first, see docs/deploy.md). CI never applies it.",
    ]
    return "\n".join(lines)


def main(argv):
    environment = argv[1] if len(argv) > 1 else None
    result = plan(environment)
    if result.returncode not in (0, 2):
        print(f"::error::railway config plan failed (exit {result.returncode}); drift unknown.")
        print(result.stderr[-2000:])
        return 2
    drift = parse_plan(result.stdout)
    if drift:
        print(report(drift, environment))
        return 1
    print(f"Railway {environment or 'linked environment'}: backend variables match .railway/railway.ts.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
