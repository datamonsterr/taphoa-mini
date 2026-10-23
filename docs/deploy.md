# Deploying the backend

Railway project `taphoa-mini` (environment `production`) hosts three services.
Mobile native builds and Maestro stay in `apps/mobile/.eas/workflows/`; mobile is
not a Railway service.

| Service    | Source and configuration                                                                      |
| ---------- | --------------------------------------------------------------------------------------------- |
| `backend`  | Uploaded with `railway up` from the repository **root**; Dockerfile `apps/backend/Dockerfile` |
| `Postgres` | Image `pgvector/pgvector:0.8.7-pg18-trixie`, volume at `/var/lib/postgresql/data`             |
| `Redis`    | Railway Redis database with volume at `/data`                                                 |

## Infrastructure as Code

The project graph lives in [`.railway/railway.ts`](../.railway/railway.ts) and uses the
`railway` npm package (root devDependency). It owns services, databases, volumes,
backend build/deploy settings (Dockerfile builder, watch patterns, `/healthz`
healthcheck, restart policy) and backend variables. Database secrets stay in Railway
through `preserve()`; backend references use `Postgres.env.DATABASE_URL` and
`Redis.env.REDIS_URL`.

Legacy `railway.json` / `railway.toml` config-as-code is deprecated by Railway (not
read after 2026-12-01, and new services cannot opt in), so this repository does not use it.

Change infrastructure by editing the file, then:

```sh
railway link --project taphoa-mini --environment production
railway config plan
railway config apply   # review the plan first; never add --confirm-destructive casually
```

`railway config plan --detailed-exit-code` exits 2 when Railway has drifted from the file.

## One-time project bootstrap (already done)

```sh
railway init --name taphoa-mini --workspace <workspace-id> --json
railway add --service backend --json
railway add --database postgres --json
railway add --database redis --json
railway service source connect --service Postgres --environment production \
  --image pgvector/pgvector:0.8.7-pg18-trixie --json
railway config pull --variables=managed   # then edited into .railway/railway.ts
```

The backend runs SQLx migrations at startup, including `CREATE EXTENSION vector`,
so the Postgres image must ship pgvector.

## Deploy and verify

From the repository root, deploy to the linked production backend:

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

## Image bucket credentials

The private Railway Bucket `images` is S3-compatible and uses region `sin`.
Provisioning remains in `.railway/railway.ts`. Obtain credentials through the CLI
in a trusted terminal; never paste them into repository files, logs, issues or PRs:

```sh
railway bucket credentials --bucket images --json
```

Use the returned endpoint, access key, secret key, bucket name and region as the
five backend storage variables. `S3_FORCE_PATH_STYLE` follows the credential
`urlStyle`: true for path style, false for virtual-hosted style. Substitute values
securely in the terminal (placeholders below are documentation only):

```sh
railway variable set --service backend \
  AWS_ENDPOINT_URL="<endpoint>" \
  AWS_ACCESS_KEY_ID="<access-key>" \
  AWS_SECRET_ACCESS_KEY="<secret-key>" \
  AWS_S3_BUCKET_NAME="<bucket-name>" \
  AWS_DEFAULT_REGION="<region>" \
  S3_FORCE_PATH_STYLE="<true-or-false-from-urlStyle>" \
  S3_CREATE_BUCKET=false IMAGE_URL_TTL_SECONDS=900 --skip-deploys
```

`--skip-deploys` stages variables without launching a deployment. Deploy separately
using the verified CI flow. Omit `S3_PUBLIC_ENDPOINT_URL` in production unless
clients need a different endpoint for the same bucket; Compose alone needs it to
replace the internal service hostname when signing. All five `AWS_*` values must
be set together and nonempty. Missing storage leaves image routes at 503 while
readiness reports `storage: "not configured"`; configured bucket access failures
make readiness fail. After deployment, upload with `POST /v1/images`, fetch
`GET /v1/images/{id}`, and download the returned URL to verify the same bytes.

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
the CI gate. Infrastructure changes go through `railway config plan/apply`, not this workflow.

No GitHub job runs EAS, so **EXPO_TOKEN is not required** in GitHub. Configure EAS
account authorization/GitHub linkage in Expo when enabling the existing native
build and Maestro workflows.

## References

- [Railway Dockerfiles and cache mounts](https://docs.railway.com/builds/dockerfiles)
- [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)
- [Railway CLI up](https://docs.railway.com/cli/up)
- [GitHub workflow_run trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Docker GitHub Actions cache](https://docs.docker.com/build/ci/github-actions/cache/)
