# Deploying the backend

Railway hosts three services in one project/environment. Mobile native builds and
Maestro stay in `apps/mobile/.eas/workflows/`; mobile is not a Railway service.

| Service    | Source and configuration                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| `backend`  | Repository **root** context; config path `/apps/backend/railway.json`; Dockerfile `apps/backend/Dockerfile` |
| `Postgres` | Postgres 17 with pgvector, persistent volume and `DATABASE_URL`                                             |
| `Redis`    | Railway Redis database service exposing `REDIS_URL`                                                         |

Keep the backend Root Directory empty (repository root). In its Railway service
settings, set **Config File** to `/apps/backend/railway.json`. A path relative to
`apps/backend` would break the Dockerfile's root-relative COPY instructions.
The JSON selects Dockerfile builds, backend watch paths, `/healthz`, and five
restart-on-failure retries. `/readyz` separately checks database/cache connectivity.

## One-time project setup

These commands are instructions for an operator; writing this guide does not run
or provision anything remotely. Verified against installed Railway CLI **5.71.0**
(`--help`, `init --help`, `add --help`, `link --help`, `environment edit --help`,
`variable set --help`, `up --help`, and `volume add --help`). Install that version
with `npm install --global @railway/cli@5.71.0`.

From the repository root, use an interactive account login for provisioning:

```sh
railway login
# For an existing project, use link instead of init:
railway link --project <project-id> --environment production --json
# OR create a new project in an explicitly chosen workspace:
railway init --name taphoa-mini --workspace <workspace-id> --json

# After either path, confirm the target before creating services:
railway status --json
railway service list --json
railway add --service backend --json
railway add --database postgres --json
railway add --database redis --json
```

Run only the creation commands for missing services. The database names used in
references below must be exactly `Postgres` and `Redis`; confirm them with
`railway service list --json`.

Before putting data into the new Postgres service, use its **Settings → Source**
to select `pgvector/pgvector:pg17` (the standard Postgres image alone is insufficient).
Keep its persistent volume mounted at `/var/lib/postgresql/data`, set
`PGDATA=/var/lib/postgresql/data/pgdata`, and retain its generated
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` and `DATABASE_URL` variables.
The equivalent source/PGDATA CLI configuration for this freshly provisioned service is:

```sh
railway service source connect --service Postgres --environment production \
  --image pgvector/pgvector:pg17 --json
railway variable set --service Postgres --environment production \
  'PGDATA=/var/lib/postgresql/data/pgdata' --json
```

Verify the volume mount in the dashboard before starting the database. For a
service with no volume, link that service, add the volume, then relink backend:

```sh
railway link --project <project-id> --environment production --service Postgres --json
railway volume add --mount-path /var/lib/postgresql/data --json
railway link --project <project-id> --environment production --service backend --json
```

Set the service's config path with the CLI (the field is `configFile` on the
service configuration, not inside `source`):

```sh
railway environment edit --environment production \
  --service-config backend configFile /apps/backend/railway.json --json
```

Configure backend service references (single quotes preserve Railway's reference syntax):

```sh
railway variable set --service backend --environment production --skip-deploys \
  'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  'REDIS_URL=${{Redis.REDIS_URL}}' \
  'RUST_LOG=info' --json
```

These resolve within Railway; do not paste local Compose URLs. The backend runs
SQLx migrations at startup, including enabling `vector`, so its database user must
have the required extension privileges. Confirm the Postgres image supports the
extension before deploying.

## Deploy and verify

Set the backend Config File path above before the first upload. From the repository
root, deploy to the linked production backend:

```sh
railway link --project <project-id> --environment production --service backend --json
railway up --service backend --ci
railway deployment list --service backend --environment production --json
railway logs --service backend --environment production --lines 100 --json
```

`--ci` streams build logs; check the submitted deployment's ID and terminal
`SUCCESS` status, then check `/readyz` through a configured Railway domain.
`--detach` only confirms upload/queueing. Never infer a healthy release solely
from an upload exit code. Failed readiness usually means missing references,
unreachable dependencies, or unsuccessful migrations.

The Docker image fetches checksum-verified ONNX Runtime using
`apps/backend/scripts/fetch-onnxruntime.sh`. SAM weights download by default.
For a deliberate model-free deployment, set `SKIP_MODELS=1` as a backend variable
before building; `/v1/segment` will return 503. Local/CI Docker builds use
`--build-arg SKIP_MODELS=1`. Models are never committed.

The Dockerfile retains cargo-chef dependency **layer** caching and omits BuildKit
cache mounts. Railway requires mount IDs prefixed `s/<service-id>-` and does not
allow environment interpolation in those IDs. Ordinary layers work without
service-specific Dockerfile edits.

## GitHub production deployment

Configure the GitHub **production** environment and add its secret `RAILWAY_TOKEN`
using a Railway **project token scoped to the production environment**. Account
login credentials are not needed in CI. The project token supplies project and
environment context in a clean checkout; the service is selected explicitly.

`.github/workflows/deploy.yml` listens for completed `CI` workflows on `main` and
requires a successful **push** run from this repository. It checks out the exact
validated SHA, skips a superseded main revision, installs CLI 5.71.0, and runs
`railway up --service backend --ci`. Production deploys are serialized. Turn off
Railway's independent GitHub autodeploy trigger for backend so it cannot bypass
the CI gate. Keep the Config File and repository-root settings on the service.

No GitHub job runs EAS, so **EXPO_TOKEN is not required** in GitHub. Configure EAS
account authorization/GitHub linkage in Expo when enabling the existing native
build and Maestro workflows.

## References

- [Railway Dockerfiles and cache mounts](https://docs.railway.com/builds/dockerfiles)
- [Railway config as code](https://docs.railway.com/config-as-code/reference)
- [Railway JSON schema](https://railway.com/railway.schema.json)
- [Railway CLI up](https://docs.railway.com/cli/up)
- [GitHub workflow_run trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Docker GitHub Actions cache](https://docs.docker.com/build/ci/github-actions/cache/)
