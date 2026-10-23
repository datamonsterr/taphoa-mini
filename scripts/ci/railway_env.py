"""Resolve public (proxy) connection settings for the Railway `test` environment.

Usage: railway_env.py [environment]   (default: test; needs RAILWAY_TOKEN or a linked CLI)

Prints, for `eval`/`>> $GITHUB_ENV` use, one `KEY=VALUE` per line. Secret values are first
announced as `::add-mask::<value>` lines on stderr so GitHub redacts them; never log stdout.
Outputs: DATABASE_URL, REDIS_URL and the AWS_*/S3_* bucket settings of the backend service.
"""

import json
import subprocess
import sys
from urllib.parse import quote

BUCKET_KEYS = [
    "AWS_ENDPOINT_URL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_S3_BUCKET_NAME",
    "AWS_DEFAULT_REGION",
    "S3_FORCE_PATH_STYLE",
]
SECRET_KEYS = {"DATABASE_URL", "REDIS_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}


def build_env(postgres, redis, backend):
    """Pure function: service variable maps -> public connection env."""
    env = {}
    host, port = postgres["RAILWAY_TCP_PROXY_DOMAIN"], postgres["RAILWAY_TCP_PROXY_PORT"]
    env["DATABASE_URL"] = (
        f"postgres://{quote(postgres['PGUSER'], safe='')}:{quote(postgres['PGPASSWORD'], safe='')}@{host}:{port}"
        f"/{postgres['PGDATABASE']}"
    )
    password = redis.get("REDIS_PASSWORD") or redis.get("REDISPASSWORD", "")
    host, port = redis["RAILWAY_TCP_PROXY_DOMAIN"], redis["RAILWAY_TCP_PROXY_PORT"]
    env["REDIS_URL"] = f"redis://default:{quote(password, safe='')}@{host}:{port}"
    for key in BUCKET_KEYS:
        if backend.get(key):
            env[key] = backend[key]
    return env


def variables(service, environment):
    result = subprocess.run(
        ["railway", "variable", "list", "--service", service, "--environment", environment, "--json"],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def main(argv):
    environment = argv[1] if len(argv) > 1 else "test"
    env = build_env(
        variables("Postgres", environment),
        variables("Redis", environment),
        variables("backend", environment),
    )
    for key, value in env.items():
        if key in SECRET_KEYS:
            print(f"::add-mask::{value}", file=sys.stderr)
    for key, value in env.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
