"""Wait until no older run of this workflow is still using its `test` job.

Usage: wait_turn.py <workflow-file> [job-name]   (default job name: test)

GitHub concurrency groups keep one running and one pending run; a newer pending run cancels the
older pending one, so epic branch validations and main deploys kept cancelling each other on the
shared Railway `test` environment. This gives a FIFO queue instead: the job waits while any run
of the same workflow with a smaller run id has its `test` job queued or in progress. Older runs
never wait on newer ones, so the queue cannot deadlock. Needs GITHUB_REPOSITORY, GITHUB_RUN_ID
and a token with `actions: read` for `gh`. Gives up after WAIT_TURN_TIMEOUT seconds (default
2400).
"""

import json
import os
import subprocess
import sys
import time

ACTIVE = ("queued", "in_progress", "waiting", "requested", "pending")


def gh(path):
    out = subprocess.run(["gh", "api", path], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def blockers(repo, workflow, job_name, own_id):
    older = set()
    for status in ACTIVE:
        runs = gh(f"repos/{repo}/actions/workflows/{workflow}/runs?per_page=100&status={status}")
        older.update(run["id"] for run in runs.get("workflow_runs", []) if run["id"] < own_id)
    waiting_on = []
    for run_id in sorted(older):
        jobs = gh(f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100").get("jobs", [])
        job = next((j for j in jobs if j.get("name") == job_name), None)
        # A run whose jobs have not been created yet is still ahead of us in the queue.
        if job is None or job.get("status") != "completed":
            waiting_on.append(run_id)
    return waiting_on


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    workflow = argv[1]
    job_name = argv[2] if len(argv) > 2 else "test"
    repo = os.environ["GITHUB_REPOSITORY"]
    own_id = int(os.environ["GITHUB_RUN_ID"])
    timeout = float(os.environ.get("WAIT_TURN_TIMEOUT", "2400"))
    interval = float(os.environ.get("WAIT_TURN_INTERVAL", "20"))

    deadline = time.monotonic() + timeout
    while True:
        ahead = blockers(repo, workflow, job_name, own_id)
        if not ahead:
            print("No older run is using the test environment; continuing.")
            return 0
        if time.monotonic() >= deadline:
            print(f"::error::Still waiting on runs {ahead} after {timeout:.0f}s", file=sys.stderr)
            return 1
        print(f"Waiting for older runs to finish their {job_name} job: {ahead}", flush=True)
        time.sleep(interval)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
