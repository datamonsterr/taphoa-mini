#!/usr/bin/env bash
# Seed the Railway `test` database with the `taphoa-seed` binary (created by epic E1).
# Tolerates its absence with a notice so the pipeline works before E1 merges.
# Needs RAILWAY_TOKEN (project token for `test`), cargo, python3.
# taphoa-seed creates or reuses Clerk test users, so the caller passes CLERK_SECRET_KEY and
# CLERK_PUBLISHABLE_KEY (optionally CLERK_API_URL) in the environment; `cargo run` inherits them
# and this script never prints them.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
manifest="$repo/apps/backend/Cargo.toml"

package="$(cargo metadata --no-deps --format-version 1 --manifest-path "$manifest" \
  | python3 -I -c '
import json, sys
meta = json.load(sys.stdin)
for pkg in meta["packages"]:
    for target in pkg["targets"]:
        if "bin" in target["kind"] and target["name"] == "taphoa-seed":
            print(pkg["name"])
            raise SystemExit
')"

if [ -z "$package" ]; then
  echo "::notice::taphoa-seed binary not present yet (epic E1); skipping the seed step."
  exit 0
fi

while IFS='=' read -r key value; do
  case "$key" in DATABASE_URL) export DATABASE_URL="$value" ;; esac
done < <(python3 -I "$here/railway_env.py" "${RAILWAY_ENVIRONMENT_NAME:-test}")

echo "Seeding the test database with taphoa-seed (package $package)"
cargo run --locked --manifest-path "$manifest" -p "$package" --bin taphoa-seed
