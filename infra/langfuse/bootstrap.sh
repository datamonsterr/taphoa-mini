#!/usr/bin/env bash
# Operator-run variable bootstrap; never execute this from an IaC review task.
set -euo pipefail
set +x

if [[ $# -ne 1 || $1 != production ]]; then
  echo 'usage: bootstrap.sh production (production only)' >&2
  exit 1
fi
if [[ -n ${RAILWAY_ENVIRONMENT:-} && ${RAILWAY_ENVIRONMENT} != production ]]; then
  echo 'refusing non-production RAILWAY_ENVIRONMENT' >&2
  exit 1
fi
command -v railway >/dev/null
command -v python3 >/dev/null

python3 - <<'PY'
"""Keep values in process memory and stdin, never in files, argv or output."""
import base64
import json
import os
import secrets
import subprocess
import sys
import uuid

ENV = "production"


def run(args, value=None):
    result = subprocess.run(args, input=value, text=True, capture_output=True)
    if result.returncode:
        # CLI diagnostics can echo credentials; deliberately suppress them.
        sys.exit("command failed; inspect service state in Railway (details suppressed)")
    return result.stdout


context = run(["railway", "status"])
fields = {key.strip(): value.strip()
          for line in context.splitlines() if ": " in line
          for key, value in [line.split(": ", 1)]}
if fields.get("Project") != "taphoa-mini" or fields.get("Environment") != ENV:
    sys.exit("refusing: link this worktree to taphoa-mini / production first")

# Provision resources with the reviewed IaC first. This script only fills missing
# variables; it never creates services, volumes, domains or buckets.
services = ["langfuse-web", "langfuse-worker", "langfuse-clickhouse", "otel-collector"]
existing = {}
for service in services:
    # Only names leave the decoding process. Values never reach terminal output.
    listing = subprocess.Popen(
        ["railway", "variable", "list", "--service", service,
         "--environment", ENV, "--json"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    names = subprocess.run(
        [sys.executable, "-c",
         "import json,sys; print(json.dumps(sorted(json.load(sys.stdin))))"],
        stdin=listing.stdout, capture_output=True, text=True,
    )
    listing.stdout.close()
    if listing.wait() or names.returncode:
        sys.exit("cannot read variable names; ensure all production services exist")
    existing[service] = set(json.loads(names.stdout))


def set_missing(service, key, value):
    if key in existing[service]:
        return
    run(["railway", "variable", "set", "--stdin", "--service", service,
         "--environment", ENV, "--skip-deploys", key], value)
    existing[service].add(key)
    print(f"set {service}.{key}")


# Do not guess the owner identity from the machine running the bootstrap.
if "LANGFUSE_INIT_USER_EMAIL" not in existing["langfuse-web"]:
    owner = os.environ.get("LANGFUSE_OWNER_EMAIL", "").strip()
    if not owner or "@" not in owner:
        sys.exit("set LANGFUSE_OWNER_EMAIL to the project owner's email")
else:
    owner = ""  # Existing value is preserved without retrieving it.

set_missing("langfuse-clickhouse", "CLICKHOUSE_DB", "default")
set_missing("langfuse-clickhouse", "CLICKHOUSE_USER", "clickhouse")
set_missing("langfuse-clickhouse", "CLICKHOUSE_PASSWORD", secrets.token_urlsafe(32))
set_missing("langfuse-clickhouse", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT", "1")

common = {
    "DATABASE_URL": "${{langfuse-postgres.DATABASE_URL}}",
    "CLICKHOUSE_URL": "http://${{langfuse-clickhouse.RAILWAY_PRIVATE_DOMAIN}}:8123",
    "CLICKHOUSE_MIGRATION_URL": "clickhouse://${{langfuse-clickhouse.RAILWAY_PRIVATE_DOMAIN}}:9000",
    "CLICKHOUSE_USER": "${{langfuse-clickhouse.CLICKHOUSE_USER}}",
    "CLICKHOUSE_PASSWORD": "${{langfuse-clickhouse.CLICKHOUSE_PASSWORD}}",
    "CLICKHOUSE_CLUSTER_ENABLED": "false",
    "REDIS_CONNECTION_STRING": "${{langfuse-redis.REDIS_URL}}",
    "NEXTAUTH_URL": "https://${{langfuse-web.RAILWAY_PUBLIC_DOMAIN}}",
    "TELEMETRY_ENABLED": "false",
    "LANGFUSE_S3_BATCH_EXPORT_ENABLED": "false",
    "HOSTNAME": "0.0.0.0",
}

uses = {"EVENT_UPLOAD": "events/", "MEDIA_UPLOAD": "media/", "BATCH_EXPORT": "exports/"}
storage_keys = {
    f"LANGFUSE_S3_{use}_{suffix}"
    for use in uses
    for suffix in ("BUCKET", "PREFIX", "REGION", "ENDPOINT", "ACCESS_KEY_ID",
                   "SECRET_ACCESS_KEY", "FORCE_PATH_STYLE")
}
if any(storage_keys - existing[service] for service in services[:2]):
    creds = json.loads(run(["railway", "bucket", "credentials", "--bucket", "langfuse",
                            "--environment", ENV, "--json"]))
    required = ("endpoint", "accessKeyId", "secretAccessKey", "bucketName", "region")
    if not all(creds.get(key) for key in required):
        sys.exit("bucket credentials missing required fields")
    for use, prefix in uses.items():
        settings = {
            "BUCKET": creds["bucketName"], "PREFIX": prefix,
            "REGION": creds["region"], "ENDPOINT": creds["endpoint"],
            "ACCESS_KEY_ID": creds["accessKeyId"],
            "SECRET_ACCESS_KEY": creds["secretAccessKey"],
            "FORCE_PATH_STYLE": "true" if str(creds.get("urlStyle", "")).lower().startswith("path") else "false",
        }
        common.update({f"LANGFUSE_S3_{use}_{key}": value for key, value in settings.items()})

web = {
    "NEXTAUTH_SECRET": base64.b64encode(secrets.token_bytes(32)).decode(),
    "SALT": base64.b64encode(secrets.token_bytes(32)).decode(),
    "ENCRYPTION_KEY": secrets.token_hex(32),
    "AUTH_DISABLE_SIGNUP": "true",
    "LANGFUSE_INIT_ORG_ID": "taphoa", "LANGFUSE_INIT_ORG_NAME": "taphoa",
    "LANGFUSE_INIT_PROJECT_ID": "taphoa", "LANGFUSE_INIT_PROJECT_NAME": "taphoa",
    "LANGFUSE_INIT_PROJECT_PUBLIC_KEY": f"pk-lf-{uuid.uuid4()}",
    "LANGFUSE_INIT_PROJECT_SECRET_KEY": f"sk-lf-{uuid.uuid4()}",
    "LANGFUSE_INIT_USER_EMAIL": owner,
    "LANGFUSE_INIT_USER_NAME": "taphoa admin",
    "LANGFUSE_INIT_USER_PASSWORD": secrets.token_urlsafe(18),
    "PORT": "3000",
}
for key, value in {**common, **web}.items():
    set_missing("langfuse-web", key, value)
worker = {key: "${{langfuse-web.%s}}" % key
          for key in ("NEXTAUTH_SECRET", "SALT", "ENCRYPTION_KEY")}
for key, value in {**common, **worker, "PORT": "3030"}.items():
    set_missing("langfuse-worker", key, value)

# Collector credentials are references; backend routing remains a separate
# per-environment operator step (private production, authenticated public test).
collector = {
    "COLLECTOR_BEARER_TOKEN": secrets.token_urlsafe(48),
    "LANGFUSE_OTLP_ENDPOINT": "https://${{langfuse-web.RAILWAY_PUBLIC_DOMAIN}}/api/public/otel",
    "LANGFUSE_PUBLIC_KEY": "${{langfuse-web.LANGFUSE_INIT_PROJECT_PUBLIC_KEY}}",
    "LANGFUSE_SECRET_KEY": "${{langfuse-web.LANGFUSE_INIT_PROJECT_SECRET_KEY}}",
    "POSTHOG_HOST": "${{backend.POSTHOG_HOST}}",
    "POSTHOG_PROJECT_TOKEN": "${{backend.POSTHOG_PROJECT_TOKEN}}",
}
for key, value in collector.items():
    set_missing("otel-collector", key, value)
print("missing variables staged; deploy and verify separately")
PY
