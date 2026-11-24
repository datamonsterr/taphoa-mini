"""Deploy a Railway service and wait for the new deployment to finish.

Usage: railway_deploy.py <service> [environment]

`railway up --ci` never returns when Railway marks the upload SKIPPED (no change against the
running deployment), which held the deploy concurrency group until the job timeout. This script
uploads with `--detach`, then polls `railway deployment list` for the new deployment. If an
upload is SKIPPED, it redeploys the service so pending environment variables (like SERVICE_VERSION
set with --skip-deploys) take effect, and polls that redeployment too. SUCCESS exits 0, FAILED /
CRASHED / REMOVED print the build log and exit 1, and no terminal status within
RAILWAY_DEPLOY_TIMEOUT seconds (default 1800) exits 1.
"""

import json
import os
import subprocess
import sys
import time

OK = {"SUCCESS", "SKIPPED"}
BAD = {"FAILED", "CRASHED", "REMOVED"}


def scope(service, environment):
    args = ["--service", service]
    if environment:
        args += ["--environment", environment]
    return args


def deployments(service, environment, limit=10):
    out = subprocess.run(
        ["railway", "deployment", "list", *scope(service, environment), "--limit", str(limit), "--json"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    data = json.loads(out)
    if isinstance(data, dict):
        data = data.get("deployments", [])
    return [(d["id"], (d.get("status") or "").upper()) for d in data]


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    service = argv[1]
    environment = argv[2] if len(argv) > 2 else ""
    timeout = float(os.environ.get("RAILWAY_DEPLOY_TIMEOUT", "1800"))
    interval = float(os.environ.get("RAILWAY_POLL_INTERVAL", "15"))

    existing = deployments(service, environment, limit=200)
    known = {deployment_id for deployment_id, _ in existing}
    upload = subprocess.run(["railway", "up", *scope(service, environment), "--detach"], check=False)
    if upload.returncode != 0:
        print(f"::error::railway up failed with exit code {upload.returncode}", file=sys.stderr)
        return upload.returncode

    def poll(deployment_id, known, skipped_is_error=False):
        deadline = time.monotonic() + timeout
        status = "UNKNOWN"
        while time.monotonic() < deadline:
            matches = [(i, s) for i, s in deployments(service, environment) if i == deployment_id]
            if matches:
                status = matches[0][1]
                if status in OK:
                    if status == "SKIPPED":
                        if skipped_is_error:
                            print(
                                f"::error::Redeployment {deployment_id} SKIPPED",
                                file=sys.stderr,
                            )
                            return 1
                        return "skipped"
                    print(f"Deployment {deployment_id} SUCCESS")
                    return 0
                if status in BAD:
                    print(f"::error::Deployment {deployment_id} {status}", file=sys.stderr)
                    subprocess.run(
                        ["railway", "logs", *scope(service, environment), "--build", "--lines", "200"],
                        check=False,
                    )
                    return 1
            elif deployment_id is None:
                fresh = [(i, s) for i, s in deployments(service, environment) if i not in known]
                if fresh:
                    deployment_id, status = fresh[0]
            time.sleep(interval)
        print(f"::error::No terminal deployment status within {timeout:.0f}s (last: {status})", file=sys.stderr)
        return 1

    result = poll(None, known)
    if result != "skipped":
        return result
    print("::notice::Upload SKIPPED; redeploying to apply pending configuration.")
    known = {deployment_id for deployment_id, _ in deployments(service, environment, limit=200)}
    redeploy = subprocess.run(
        ["railway", "redeploy", *scope(service, environment), "--yes", "--json"],
        capture_output=True,
        text=True,
        check=False,
    )
    if redeploy.returncode != 0:
        print(f"::error::railway redeploy failed with exit code {redeploy.returncode}", file=sys.stderr)
        if redeploy.stderr:
            print(redeploy.stderr, file=sys.stderr, end="")
        return redeploy.returncode or 1
    try:
        response = json.loads(redeploy.stdout)
        deployment_id = response.get("id") if isinstance(response, dict) else None
    except json.JSONDecodeError:
        deployment_id = None
    if not deployment_id:
        deployment_id = next((i for i, _ in deployments(service, environment) if i not in known), None)
    return poll(deployment_id, known, skipped_is_error=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
