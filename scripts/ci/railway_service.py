"""Start or stop an image-based Railway service without deleting its volume.

Usage: railway_service.py <up|down> <service> <environment>

up leaves an existing SUCCESS deployment running. Otherwise it redeploys with
--from-source (required after `down` for image services) and waits for a new
deployment's SUCCESS. The JSON response may contain only {"success": true}, so
poll deployment list rather than expecting a deployment id in that response.
RAILWAY_DEPLOY_TIMEOUT (default 300 seconds) and RAILWAY_POLL_INTERVAL (default 5)
bound polling. down delegates to railway_down.py, including its no-deployment
handling. Callers must hold the shared test-environment FIFO through teardown.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import time


def up(service, environment):
    scope = ["--service", service, "--environment", environment]

    def deployments():
        result = subprocess.run(
            ["railway", "deployment", "list", *scope, "--limit", "200", "--json"],
            capture_output=True, text=True, check=True,
        )
        rows = json.loads(result.stdout)
        if isinstance(rows, dict):
            rows = rows.get("deployments", [])
        return [(row["id"], (row.get("status") or "").upper()) for row in rows]

    existing = deployments()
    if any(status == "SUCCESS" for _, status in existing):
        print(f"{service} in {environment} is already running; continuing.")
        return 0
    known = {deployment_id for deployment_id, _ in existing}
    result = subprocess.run(
        ["railway", "redeploy", *scope, "--yes", "--from-source", "--json"], check=False,
    )
    if result.returncode:
        return result.returncode

    timeout = float(os.environ.get("RAILWAY_DEPLOY_TIMEOUT", "300"))
    interval = float(os.environ.get("RAILWAY_POLL_INTERVAL", "5"))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        # Lists are newest first. Ignore the old history while Railway creates
        # the deployment; a stale terminal status must not decide this start.
        rows = deployments()
        if rows and rows[0][0] not in known:
            deployment_id, status = rows[0]
            print(f"{service} {deployment_id} {status}", flush=True)
            if status == "SUCCESS":
                return 0
            if status in {"FAILED", "CRASHED", "REMOVED"}:
                print(f"::error::{service} deployment {deployment_id} {status}", file=sys.stderr)
                return 1
        time.sleep(interval)
    print(f"::error::{service} did not reach SUCCESS within {timeout:g}s", file=sys.stderr)
    return 1


def main(argv):
    if len(argv) != 4 or argv[1] not in {"up", "down"}:
        print(__doc__, file=sys.stderr)
        return 2
    operation, service, environment = argv[1:]
    if operation == "down":
        return subprocess.run(
            [sys.executable, "-I", str(Path(__file__).with_name("railway_down.py")), service, environment],
            check=False,
        ).returncode
    return up(service, environment)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
