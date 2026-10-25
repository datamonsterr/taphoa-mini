"""Decide whether a run of the nightly workflow eval.yml should do its work (epic X7).

    python3 -I scripts/ci/eval_guard.py --event E --set S [--compare-models M] [--force]
        --repo OWNER/REPO --run-id N --today YYYY-MM-DD [--assistant-dir DIR]

Prints `run=true|false` and `reason=...` lines, ready for $GITHUB_OUTPUT. Needs `gh` and GH_TOKEN
(actions: read) when it has to look at earlier runs.

Rules:
- A scheduled run is skipped while the assistant code is not on main (the live path is wired
  in task T7), so the schedule stays quiet before epic X3 lands.
- A full run is skipped when an earlier run titled `eval full` started today (UTC), did its
  work and succeeded, or is still running. `--force` skips this check.
- Smoke and compare runs are never skipped (the harness guards the OpenRouter quota itself).
"""

import argparse
import json
import pathlib
import subprocess
import sys
from datetime import datetime, timedelta, timezone

WORKFLOW = "eval.yml"
# The job that does the work; a run whose job was skipped did nothing and does not count.
WORK_JOB = "run"


def blocking_run(runs, jobs_of, today, run_id, title):
    """The first earlier run of `title` that started today (UTC) and succeeded or is running."""
    for run in sorted(runs, key=lambda r: r["id"]):
        if run["id"] >= run_id or run.get("display_title") != title:
            continue
        if (run.get("run_started_at") or run["created_at"])[:10] != today:
            continue
        if run["status"] != "completed":
            return run
        if run.get("conclusion") != "success":
            continue
        job = next((j for j in jobs_of(run["id"]) if j["name"] == WORK_JOB), None)
        if job is not None and job.get("conclusion") == "success":
            return run
    return None


def decide(event, set_name, compare_models, force, assistant_present, runs_of, jobs_of, today, run_id):
    """Return (run, reason). `runs_of()` is only called when the answer depends on earlier runs."""
    if event == "schedule" and not assistant_present:
        return False, "the assistant (epic X3) is not on main yet"
    if compare_models or set_name != "full":
        return True, "only full runs are limited to one a day"
    if force:
        return True, "force: the once-a-day check was skipped"
    earlier = blocking_run(runs_of(), jobs_of, today, run_id, "eval full")
    if earlier is not None:
        state = "succeeded" if earlier["status"] == "completed" else "is still running"
        return False, f"full run {earlier['id']} started today (UTC) and {state}"
    return True, "no other full run succeeded or is running today (UTC)"


def gh_api(repo, path, *extra):
    result = subprocess.run(
        ["gh", "api", "--method", "GET", f"repos/{repo}/{path}", *extra],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        # Fail loudly: guessing "no earlier run" could spend the day's quota twice.
        sys.exit(f"gh api repos/{repo}/{path} failed: {result.stderr.strip()}")
    out = result.stdout
    # `--jq '.x[]'` prints one JSON value per element, compact when not on a terminal.
    decoder, items, pos = json.JSONDecoder(), [], 0
    while True:
        while pos < len(out) and out[pos].isspace():
            pos += 1
        if pos >= len(out):
            return items
        item, pos = decoder.raw_decode(out, pos)
        items.append(item)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--event", required=True)
    parser.add_argument("--set", dest="set_name", default="full")
    parser.add_argument("--compare-models", default="")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--today", default=datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    parser.add_argument("--assistant-dir", default="apps/backend/crates/api/src/assistant")
    args = parser.parse_args(argv)

    def runs_of():
        # `created` has day granularity: ask from yesterday so a run queued before midnight
        # and started after it is still seen; `decide` filters by the start date.
        since = (datetime.strptime(args.today, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        return gh_api(
            args.repo,
            f"actions/workflows/{WORKFLOW}/runs",
            "--paginate",
            "--jq",
            ".workflow_runs[]",
            "-f",
            f"created=>={since}",
            "-f",
            "per_page=100",
        )

    def jobs_of(run_id):
        return gh_api(args.repo, f"actions/runs/{run_id}/jobs", "--paginate", "--jq", ".jobs[]", "-f", "per_page=100")

    run, reason = decide(
        args.event,
        args.set_name,
        args.compare_models,
        args.force,
        pathlib.Path(args.assistant_dir).is_dir(),
        runs_of,
        jobs_of,
        args.today,
        args.run_id,
    )
    print(f"run={'true' if run else 'false'}")
    print(f"reason={reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
