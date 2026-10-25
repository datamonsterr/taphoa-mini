# Deploying the backend

Railway project `taphoa-mini` has two environments, `production` and `test`, each with
three services (the `test` environment is a duplicate of production with its own data).
Mobile native builds and the web deploy stay in `apps/mobile/.eas/workflows/`; mobile is
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

## Railway `test` environment

`test` mirrors production but is isolated: its own Postgres (pgvector), Redis, `images`
bucket and `backend` service, deployed from any branch to validate it with real
infrastructure before merge. Backend URL: **https://backend-test-70c2.up.railway.app**.

Created once with:

```sh
railway environment create test --duplicate production --json
railway bucket create images --region sin --environment test      # test-only bucket
railway config plan --environment test                              # review, then:
railway config apply --environment test                             # applies .railway/railway.ts
railway tcp-proxy create --port 5432 --service Postgres --environment test
railway tcp-proxy create --port 6379 --service Redis --environment test
```

Backend variables were set with the CLI only (values never printed): the Clerk keys
(see [Clerk identity](#clerk-identity)) come from the local secrets file and are piped through
`railway variable set --stdin`; the five bucket variables come from
`railway bucket credentials --bucket images --environment test --json` piped into
`railway variable set --stdin`. `SKIP_MODELS` is unset, so SAM weights stay in the test
image. The TCP proxies expose Postgres and Redis publicly (credentials still required) so
CI can seed and run integration tests (`scripts/ci/railway_env.py` builds the URLs).

Watch patterns (`apps/backend/**`, `rust-toolchain.toml`) apply to CLI deploys too: a
`railway up` whose snapshot has no backend change versus the last deployment ends as
`SKIPPED`, meaning the running deployment already matches.

## Clerk identity

Identity is Clerk ([ADR 0004](adr/0004-clerk-identity.md), [contract](specs/assistant/auth-clerk.md)).
Both Railway environments, CI and local development use one Clerk **development instance**
(Frontend API `full-moccasin-5407.clerk.accounts.dev`) until a domain exists for a production
instance. The backend no longer signs tokens or reads `JWT_SECRET`.

- **Verification.** Every protected route takes `Authorization: Bearer <Clerk session JWT>`.
  The backend verifies RS256 against the instance JWKS (cached in memory; an unknown `kid`
  refetches at most once a minute), checks `exp`/`nbf` with 5 s leeway, `iss`, and `azp` when
  both the token and `CLERK_AUTHORIZED_PARTIES` carry it, and rejects pending sessions.
  Verification makes no Clerk call per request.
- **Store selection.** The `X-Store-Id` header picks the store: required when the Clerk user has
  more than one membership, optional with exactly one. A store without an active membership
  gives 403.
- **Profile.** Display name and email come from the Clerk Backend API (`GET /v1/users/{id}`,
  needs `CLERK_SECRET_KEY`), cached in Redis for 10 minutes. Without the secret key `profile`
  is `null`.

| Variable (backend)               | Required | Meaning                                                                             |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `CLERK_PUBLISHABLE_KEY`          | yes      | Gives the Frontend API host: issuer `https://<host>`, JWKS `/.well-known/jwks.json` |
| `CLERK_SECRET_KEY`               | no       | Backend API key for profile reads; a secret                                         |
| `CLERK_API_URL`                  | no       | Backend API base URL (default `https://api.clerk.com`)                              |
| `CLERK_AUTHORIZED_PARTIES`       | no       | Comma-separated origins allowed in the token's `azp` claim                          |
| `CLERK_ISSUER`, `CLERK_JWKS_URL` | no       | Override the values derived from the publishable key (tests point them at a stub)   |

Startup fails when no issuer can be derived. An empty or whitespace-only `CLERK_*` value counts as
unset. The publishable key is public by design (it ships in the app bundle), so Compose,
`scripts/e2e/stack.sh` and the backend `.env.example` default to the development instance key; the
secret key is never committed.

**Where each value lives.**

| Value                                                      | Where                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`             | Railway `backend` variables in `test` and `production` (`preserve()` in `.railway/railway.ts`) |
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`                        | EAS environment variables (all environments); the web export and native builds embed it        |
| GitHub secrets `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | CI (below); set with `gh secret set` from `~/.config/taphoa-mini/secrets.env`                  |
| Local copies                                               | `~/.config/taphoa-mini/secrets.env` (never in git, logs, PRs or chat)                          |

Set a Railway variable from the terminal without printing it, per environment:

```sh
grep '^CLERK_SECRET_KEY=' ~/.config/taphoa-mini/secrets.env | cut -d= -f2- | tr -d '\n' \
  | railway variable set --stdin CLERK_SECRET_KEY --service backend --environment test --skip-deploys
```

**CI use of the secrets.** Secrets are unavailable to fork and dependabot runs, so those jobs
degrade with a `::notice::` instead of failing.

| Workflow / job                         | Secrets and variables                                                                                                                                                     | Without the secrets                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `ci.yml` `docker-e2e`                  | `CLERK_PUBLISHABLE_KEY` to Compose; `CLERK_SECRET_KEY` to `apps/backend/scripts/e2e.sh`, which creates a `+clerk_test` user, mints a 10 minute token and deletes the user | Authenticated checks (store, images) skipped |
| `ci.yml` `web-e2e`                     | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (the export embeds it)                                                                   | Job skipped (`clerk-secrets` gate)           |
| `android-e2e.yml` `maestro`, `expo-go` | Backend stack gets both keys; the app build and Metro get `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`                                                                             | Jobs skipped (`clerk-secrets` gate)          |
| `deploy.yml` `test` (seed and e2e)     | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` for `scripts/ci/seed-test.sh` and `scripts/ci/run-e2e.sh`                                                                     | `run-e2e.sh` fails fast naming the secret    |
| `railway-integration.yml`              | none: the integration tests run in-process                                                                                                                                | n/a                                          |

The e2e helpers, the seed and `e2e.sh` all call the Clerk Backend API with the one secret key. On
a development instance that API allows 100 requests per 10 s for every holder of the key (both
Railway environments, seed, e2e, CI), so the helpers throttle themselves and retry a 429 after
`Retry-After`. Users created for tests use `e2e-<unique>+clerk_test@example.com` (code `424242`,
no mail is sent) and are deleted afterwards; `pnpm --filter @taphoa/e2e run clerk:sweep` removes
leftovers older than 24 h.

**Rollout order.** `JWT_SECRET` stays in `.railway/railway.ts` and on both environments until the
Clerk release is live; then delete it from the file (and the variable) in a follow-up. Deploying
the Clerk branch to `test` applies migration `0701`, after which `main` code fails there, so the
epic branch goes to `test` only when everything else is green and merges right after.

## CI pipeline

`.github/workflows/ci.yml` splits work into small parallel jobs (target under 3 minutes
warm). `changes` (dorny/paths-filter) skips unaffected areas. Rust jobs share
`Swatinem/rust-cache` keys; `rust-build` produces one `cargo nextest archive` artifact that
`rust-test` (partitions 1/2 and 2/2) and `rust-integration` (service containers) run
without recompiling. JS jobs use the pnpm store cache and a Turborepo cache
(`.github/actions/setup-js`). `docker-build` uses buildx with the GHA cache and shares the
image as an artifact for `docker-e2e`, whose smoke script mints a Clerk session token for the
store and image checks; `web-e2e` signs in through Clerk, and a tiny `clerk-secrets` job gates it
so fork and dependabot runs (no secrets) skip with a notice. Each job appends a summary (JUnit counts through
`scripts/ci/junit_summary.py`, duration through `scripts/ci/job-summary.sh`) and uploads
JUnit or compose logs on failure. `ci-ok` aggregates everything (skipped counts as
success) and prints a job timing table. The Docker image in CI is a thin wrapper (`apps/backend/Dockerfile.ci`) around a release binary built by `backend-binary` in `rust:1-bookworm` with a persistent cargo/target cache, so backend source changes stay under 3 minutes. The full cargo-chef `apps/backend/Dockerfile` that Railway builds is verified separately in `docker-full.yml` (push to main, nightly, Dockerfile changes), outside the required gate. Make `ci-ok` the only required status check.
`scripts/ci` has its own unit tests (`python3 -m unittest discover -s scripts/ci`).

## Deploy pipeline

`.github/workflows/deploy.yml`:

1. After CI succeeds for a push to `main`: `railway up --service backend --environment test`,
   wait for `/healthz` and `/readyz`, run `scripts/ci/seed-test.sh` (the `taphoa-seed`
   binary, which creates or reuses Clerk test users; skipped with a notice until it exists),
   then `scripts/ci/run-e2e.sh` (`packages/e2e` against `BACKEND_URL_TEST` plus p95 latency
   probes; falls back to smoke and latency probes with a notice while the suite is absent).
   Both steps get `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` from GitHub secrets, and
   `run-e2e.sh` fails fast when the suite exists and `CLERK_SECRET_KEY` is empty.
2. Only when that passes: deploy `production` and smoke it as described below.
3. `workflow_dispatch` with a `ref` input runs step 1 for any branch or SHA and stops, so
   epic branches can be validated before merge.

Deploys are serialized per environment (`deploy-railway-test`,
`deploy-railway-production`, no cancellation). `.github/workflows/railway-integration.yml`
runs the `#[ignore]` integration tests against the real `test` Postgres, Redis and bucket
(manual, nightly 20:17 UTC and on backend changes to `main`) via
`scripts/ci/with-railway-test-services.sh`: a throwaway database `it_<run>` is created and
dropped per run, Redis logical database 15 is flushed afterwards, and the bucket is shared
and append-only.

### GitHub configuration for the test environment

| Kind     | Name                    | Value                                                                          |
| -------- | ----------------------- | ------------------------------------------------------------------------------ |
| Secret   | `RAILWAY_TOKEN_TEST`    | Railway **project token** for environment `test` (dashboard > Tokens)          |
| Secret   | `CLERK_SECRET_KEY`      | Clerk Backend API key: seed, e2e helpers and the docker smoke create users     |
| Secret   | `CLERK_PUBLISHABLE_KEY` | Clerk Frontend API key (public by design); also embedded in web and app builds |
| Variable | `BACKEND_URL_TEST`      | `https://backend-test-70c2.up.railway.app`                                     |
| Variable | `LATENCY_P95_MS`        | Optional p95 budget in milliseconds for the e2e latency probes (default 200)   |

Project tokens cannot be minted with the CLI login, so the secret must be created in the
Railway dashboard (Project settings > Tokens, environment `test`) and added with
`gh secret set RAILWAY_TOKEN_TEST`. Until it exists the test deploy, e2e and Railway
integration steps are skipped with a notice and production deploys behave as before.

## GitHub production deployment

Configure the GitHub **production** environment and add its secret `RAILWAY_TOKEN`
using a Railway **project token scoped to the production environment**. Account
login credentials are not needed in CI. The project token supplies project and
environment context in a clean checkout; the service is selected explicitly.

`.github/workflows/deploy.yml` listens for completed `CI` workflows on `main` and
requires a successful **push** run from this repository. It checks out the exact
validated SHA, skips a superseded main revision, installs CLI 5.71.0, and runs
`railway up --service backend --ci` in the `production` job, which `needs` the `test`
job (deploy, seed, e2e). Production deploys are serialized. Turn off
Railway's independent GitHub autodeploy trigger for backend so it cannot bypass
the CI gate. Infrastructure changes go through `railway config plan/apply`, not this workflow.

`RAILWAY_TOKEN` is optional for a green pipeline: when the secret is empty or missing,
the workflow emits a `::notice::` and skips the Railway CLI install, `railway up` and
the smoke test, so `main` stays green before the secret exists.

**Post-deploy smoke.** After `railway up`, if the repository **variable** `BACKEND_URL`
(for example `https://backend-production.up.railway.app`, no trailing path) is set, the
workflow runs `curl` against `$BACKEND_URL/healthz` and `$BACKEND_URL/readyz`, expecting
HTTP 200, retrying every 10 seconds for up to 30 attempts per endpoint. The job fails if
either never answers 200. Without `BACKEND_URL` this step is skipped with a notice.
Set it under Settings > Secrets and variables > Actions > Variables.

No GitHub job runs EAS, so **EXPO_TOKEN is not required** in GitHub. Configure EAS
account authorization/GitHub linkage in Expo when enabling the existing native
build and Maestro workflows.

## References

- [Railway Dockerfiles and cache mounts](https://docs.railway.com/builds/dockerfiles)
- [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)
- [Railway CLI up](https://docs.railway.com/cli/up)
- [GitHub workflow_run trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Docker GitHub Actions cache](https://docs.docker.com/build/ci/github-actions/cache/)

## Client IP and auth rate limits

Per-IP limits on store creation and join never trust a client-set header.

| Variable                           | Default | Meaning                                                                                                |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `CLIENT_IP_SOURCE`                 | `peer`  | `peer` (socket address), `x-real-ip`, or `x-forwarded-for` (entry `TRUSTED_PROXY_HOPS` from the right) |
| `TRUSTED_PROXY_HOPS`               | `1`     | Only for `x-forwarded-for`                                                                             |
| `RATE_LIMIT_STORE_CREATE_PER_HOUR` | `10`    | `POST /v1/stores` per client IP                                                                        |
| `RATE_LIMIT_JOIN_PER_HOUR`         | `10`    | `POST /v1/auth/join` per client IP                                                                     |
| `RATE_LIMIT_PIN_ATTEMPTS`          | `5`     | Wrong PINs before a 5 minute member lock                                                               |

Railway's edge sets `X-Real-IP` to the client address and does not set `X-Forwarded-For`
([specs and limits](https://docs.railway.com/networking/public-networking/specs-and-limits)),
so the production `backend` service must set `CLIENT_IP_SOURCE=x-real-ip`. With the default
`peer`, every request appears to come from the Railway proxy and all clients share one bucket.
This is deliberately not in `.railway/railway.ts`; set it as a service variable. The Railway
test environment and local compose raise the two per-IP `RATE_LIMIT_*` limits (compose defaults to 100000) so e2e suites can create many stores; never raise them in production.
