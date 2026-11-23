# Deploying the backend

Railway project `taphoa-mini` has two environments: `production` runs five services,
and `test` runs the three application services with its own data. The telemetry
collector and the `landing` marketing page run only in production; the collector receives
signals from both environments.
Mobile native builds and the web deploy stay in `apps/mobile/.eas/workflows/`; mobile is
not a Railway service.

| Service          | Source and configuration                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`        | Uploaded with `railway up` from the repository **root**; Dockerfile `apps/backend/Dockerfile`                                                                                                                        |
| `Postgres`       | Image `pgvector/pgvector:0.8.7-pg18-trixie`, volume at `/var/lib/postgresql/data`                                                                                                                                    |
| `Redis`          | Railway Redis database with volume at `/data`                                                                                                                                                                        |
| `otel-collector` | Production only; root upload, Dockerfile `infra/otel-collector/Dockerfile`, public/private OTLP port 4318                                                                                                            |
| `landing`        | Production only; GitHub `main` (`apps/landing/**`), Dockerfile `apps/landing/Dockerfile` (Caddy serving `dist/`), CDN on, no sleep. Hosting decision: [ADR 0010](adr/0010-landing-static-site.md#hosting-2026-11-03) |

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

> **Warning: a full `railway config apply` is destructive.** The apply is project-wide and
> the plan deletes any bucket the file does not declare, so a stale file can
> destroy product photos (issue #295). Read the whole plan, not only the variable lines, and
> stop on any `- Delete`, any `region` change or any `source.*` change. Never pass
> `--confirm-destructive` to get past one. Apply one environment at a time with
> `--environment <env>`.
>
> The file declares every live bucket per environment (production: `images-prod`, `images-sin`;
> test: `images`, `images-sjc`) and the live volume region (`sfo`). When a bucket or volume is
> added or removed in Railway, update `.railway/railway.ts` in the same change.
>
> How the file was verified (issue #295): `railway config pull --json --environment <env>`
> (read-only; inspect resource names, regions and sources only) showed the live shape, the file
> was edited to match it, and `railway config plan --environment test` and `--environment
production` both then printed "Your Railway configuration is already up to date" (no
> creates, updates or deletes). Repeat that check after every IaC change.

### Variable drift check in the deploy workflow

The "Deploy backend" workflow does not apply `.railway/railway.ts`. It only sets
`SERVICE_VERSION` and deploys the image, so a changed managed variable never reaches Railway
by itself (this is how `DECISIONS_MODEL` went stale, issue #278). Instead it checks drift and
fails when Railway differs:

- The `test` job runs `python3 -I scripts/ci/railway_drift.py test` before the deploy, and the
  `production` job runs `railway_drift.py production` before its deploy.
- The script runs `railway config plan --detailed-exit-code` (read-only) and keeps only the
  `backend` variable lines. It prints variable names and `set` / `change` / `delete`, never
  values: the plan is redacted, `--show-values` is never passed, and the raw plan is not logged,
  so `preserve()`d database and API secrets cannot leak. If the plan itself errors (token,
  CLI), the job fails rather than passing blind.
- Apply is not automated because `railway config apply` is project-wide, not scoped to backend
  variables. The check ignores non-variable plan lines (volumes, buckets, `source.*`); since
  #295 the file matches live for those, so a full plan should be empty. If one reappears, treat it
  as drift to reconcile in `.railway/railway.ts`, never as something to apply blindly.

When the check turns the deploy red, a human fixes it, then re-runs the workflow:

1. Locally, `railway link`, then `railway config plan --environment <env>` and read the
   `backend` variable lines.
2. Either edit `.railway/railway.ts` to match Railway (use `preserve()` for per-environment
   values and secrets), or set the variable, for example
   `railway variable set --service backend --environment <env> NAME=value`.
3. Run `python3 -I scripts/ci/railway_drift.py <env>` locally; it must print "match".

Do not run `railway config apply` for this: it would also apply the non-variable plan lines.
The `railway/iac` SDK finds the CLI through `$_`, so always run the script through `python3`
as above (the script sets `_` itself).

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

### Assistant

Railway uses `ASSISTANT_MODEL_PROVIDER=openrouter` and
`ASSISTANT_REASONING_EFFORT=low` in `.railway/railway.ts`. Production must never
use the `scripted` provider. Local `.env.example` files select `scripted` so local
assistant turns need no model network calls. OpenRouter uses the shared
`OPENROUTER_API_KEY`; paid and `:free` OpenRouter model IDs are accepted. Paid generations report actual OpenRouter usage costs; keep a finite USD limit on each environment key.

Voice uses the same key. OpenRouter can require **at least $0.50 of remaining key
allowance for audio**, even when text requests succeed and the account has credit.
If voice logs show `spend_limit`, HTTP/code `402`, and
`limit_source=openrouter_key_limit`, raise the environment key's limit in
[OpenRouter Settings → API Keys](https://openrouter.ai/settings/keys) so its remaining
allowance stays above that minimum (leave headroom for ongoing usage). Keep a finite
limit. An account top-up alone does not raise a key's allowance; replacing the key also
requires updating Railway's `OPENROUTER_API_KEY`. Model/routing/timeout changes do not
resolve this rejection. Voice warnings retain the HTTP status, router code, limit
source, and a bounded operational message prefix; unrecognized prose and provider
raw metadata are redacted because they can contain request content.

The scheduled `eval.yml` workflow checks `GET /api/v1/key` once a day using the
repository's `OPENROUTER_API_KEY`. It opens one `budget-alert` issue when that
key's `limit_remaining` falls below the repository variable
`OPENROUTER_BUDGET_THRESHOLD` (default `$2`), comments on the existing issue on
subsequent low checks, and comments and closes it after recovery. The alert script
fails visibly if the API cannot be read; it does not interpret an API error as zero
credit. If both `limit` and `limit_remaining` are null, the key is unlimited: the
check prints a notice and does not alert because this endpoint cannot show account
credit. A live eval refused by its own estimated-budget preflight succeeds with a
`skipped: budget` annotation, summary, and `run` job output `result` so downstream
jobs can distinguish it from an evaluation failure.

| Variable                                 | Default / purpose                                                          | Railway management                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ASSISTANT_MODEL_PROVIDER`               | Backend default `openrouter`; local examples use `scripted`                | Fixed `openrouter`                                                            |
| `ASSISTANT_MODELS`                       | Ordered fallbacks: `z-ai/glm-5.3-flash,nvidia/nemotron-3.5-lightning:free` | Per environment, `preserve()`; X7 updates the order                           |
| `ASSISTANT_DAILY_MESSAGES_PER_STORE`     | `60` user messages per store per business day                              | Per environment, `preserve()`                                                 |
| `ASSISTANT_ALLOW_EVAL_HEADERS`           | Backend default `0`; `1` enables eval run/model headers and pinned dates   | Per environment, `preserve()`; `1` on `test` only, `0` or unset in production |
| `ASSISTANT_REASONING_EFFORT`             | `low`                                                                      | Fixed `low`                                                                   |
| `ASSISTANT_FEEDBACK_SURVEY_ID`           | Optional PostHog survey id                                                 | Per environment, `preserve()`                                                 |
| `ASSISTANT_FEEDBACK_QUESTION_ID`         | Optional rating question id; required with survey id                       | Per environment, `preserve()`                                                 |
| `ASSISTANT_FEEDBACK_COMMENT_QUESTION_ID` | Optional comment question id                                               | Per environment, `preserve()`                                                 |
| `ASSISTANT_OPENROUTER_URL`               | `https://openrouter.ai/api/v1/chat/completions`                            | Backend default; local mock override                                          |
| `ASSISTANT_FIRST_TOKEN_TIMEOUT_MS`       | `20000` ms to the first token                                              | Backend default                                                               |
| `ASSISTANT_MODEL_TIMEOUT_MS`             | `60000` ms per model attempt                                               | Backend default                                                               |

Preserved values are configured independently on `test` and `production`; applying
IaC keeps their existing values. Eval headers must never be enabled in production.
Feedback is stored even without survey configuration; creating PostHog surveys is
a separate setup step.

The deployed assistant contract suite is `packages/e2e/tests/assistant.test.ts`.
Run it on Railway `test` with `BACKEND_URL` set. It sends at most four live
messages (up to six model calls each, at most 24 calls), asserts response structure,
and visibly skips remaining live checks when the shared daily quota is exhausted.
Set `E2E_ASSISTANT_LIVE=0` to run only deterministic endpoint checks against a local
backend. Live checks expect real OpenRouter model IDs and are for the controller to run
on `test`.

## Telemetry

Backend traces and logs use OTLP/HTTP protobuf. The backend redacts both signals
before export, whether routed through the collector or directly to PostHog Cloud
US. Business events retain their separate PostHog capture configuration.
[ADR 0011](adr/0011-scale-to-zero-hosting.md) retires the always-on collector.

Until cutover, production uses
`http://${{otel-collector.RAILWAY_PRIVATE_DOMAIN}}:4318`; test uses
`https://otel-collector-production-ce86.up.railway.app`. Both use the collector
bearer token. The direct base endpoint is `https://us.i.posthog.com/i`:
`/v1/traces` and `/v1/logs` are appended, preserving `/i`. This matches
[opentelemetry-otlp 0.33.1 endpoint semantics](https://docs.rs/opentelemetry-otlp/0.33.1/opentelemetry_otlp/#environment-variables)
and [PostHog's logs endpoint and bearer authentication](https://posthog.com/docs/logs/installation/other).
No additional routing setting is needed.

| Service   | Variable                      | Purpose                                                                                                                                                                                                              |
| --------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend   | `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL: collector URL today, `https://us.i.posthog.com/i` for direct export; absent means local logs only                                                                                                     |
| Backend   | `OTEL_EXPORTER_OTLP_HEADERS`  | `Authorization=Bearer%20<project-token>` direct, or the collector token through the collector (W3C/OTel env format; space URL-encoded)                                                                               |
| Backend   | `OTEL_SERVICE_NAME`           | Resource service name, default `taphoa-backend`                                                                                                                                                                      |
| Backend   | `TELEMETRY_ENVIRONMENT`       | Optional override; by default the backend uses Railway's `RAILWAY_ENVIRONMENT_NAME` (`production`, `test`), else `local`                                                                                             |
| Backend   | `SERVICE_VERSION`             | Release identifier; the deploy workflow sets it to the deployed SHA before `railway up`; fallback is Railway commit SHA, then an optional local `.service-version` file in the working directory, then crate version |
| Backend   | `OTEL_SDK_DISABLED`           | `true` disables telemetry export                                                                                                                                                                                     |
| Collector | `COLLECTOR_BEARER_TOKEN`      | Required bearer credential on OTLP ingress                                                                                                                                                                           |
| Collector | `POSTHOG_HOST`                | PostHog Cloud US ingestion host                                                                                                                                                                                      |
| Collector | `POSTHOG_PROJECT_TOKEN`       | PostHog project token for OTLP export                                                                                                                                                                                |

### Direct export cutover (controller)

| Environment           | `OTEL_EXPORTER_OTLP_ENDPOINT` | `OTEL_EXPORTER_OTLP_HEADERS`                        | Environment resource                                          |
| --------------------- | ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| `production`          | `https://us.i.posthog.com/i`  | `Authorization=Bearer%20<production-project-token>` | `production` from Railway                                     |
| `test`                | `https://us.i.posthog.com/i`  | `Authorization=Bearer%20<test-project-token>`       | `test` from Railway                                           |
| Local / eval (opt in) | `https://us.i.posthog.com/i`  | `Authorization=Bearer%20<project-token>`            | `local` by default; set `TELEMETRY_ENVIRONMENT=eval` for eval |

Use the PostHog project token already configured for that environment's business
events (it can be the same project in production and test). Supply the header
securely at runtime; never commit or print its value. `Bearer%20` is the portable
URL-encoded space form; `Authorization=Bearer <project-token>` is also accepted.

1. Set the two OTLP variables above in each backend environment, starting with test.
2. Redeploy the backend. Leave the collector running for rollback.
3. Send a request and check its trace and log in PostHog with the expected
   `deployment.environment.name`, service version and trace correlation. Confirm
   the redaction examples below contain no sensitive data. The controller performs
   this live check; automated tests use loopback capture only.
4. After production has run for one week on direct export, remove the collector
   service and its IaC declaration in a later reviewed change. This change leaves
   the service and `.railway/railway.ts` intact.

Rollback before removal: restore the collector endpoint and bearer header, then
redeploy. Production's existing references are
`http://${{otel-collector.RAILWAY_PRIVATE_DOMAIN}}:4318` and
`Authorization=Bearer%20${{otel-collector.COLLECTOR_BEARER_TOKEN}}`; test uses the
public HTTPS URL and a securely supplied copy of the collector header.

### Redaction, retry and shutdown

`apps/backend/crates/api/src/telemetry/redaction.rs` wraps both SDK exporters,
including their resources. Its rules must match `infra/otel-collector/config.yaml`
until retirement; both suites read `infra/otel-collector/tests/redaction-cases.json`.

| Collector rule                                                                    | Backend rule                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transform/redact`: delete matching resource/span/log keys                        | Case-insensitive `http.request.header.authorization`, any key containing `cookie`, exact `token`/`secret`, or keys ending `.token`/`.secret` with a nonempty prefix |
| `replace_pattern(log.body, "[0-9]{9,15}", "[REDACTED]") where IsString(log.body)` | Same unanchored digit regex and replacement on string bodies only; longer runs are masked in chunks, other body types pass unchanged                                |
| `resource/defaults`: insert environment `unknown`                                 | Insert only when `deployment.environment.name` is absent; preserve existing values (including empty strings)                                                        |

There is no attribute allowlist or value masking rule. Unmatching attributes,
span events, links and instrumentation scopes pass unchanged, just as with the
collector. In particular, bare `authorization` and `access_token` do not match
its key rule. Do not put credentials in those fields or arbitrary bodies.

The pinned `opentelemetry`, `opentelemetry_sdk` and `opentelemetry-otlp` versions
are **0.33.1**. SDK batch defaults are 2,048 queued records per signal, batches of
512, trace delay 5 s and log delay 1 s (standard `OTEL_BSP_*` / `OTEL_BLRP_*`
variables can override these). The batch processors do not requeue failed batches.
The [OTLP HTTP exporter](https://docs.rs/opentelemetry-otlp/0.33.1/opentelemetry_otlp/)
itself retries transport failures and HTTP 429/502/503/504: at most three retries,
starting at 100 ms with exponential backoff capped at 1,600 ms and up to 100 ms
jitter. It honors `Retry-After` seconds. Other HTTP failures are permanent.
The exporter timeout defaults to 10 s (`OTEL_EXPORTER_OTLP_TIMEOUT`, milliseconds,
or signal-specific timeout); this bounds retry decisions and sleeps, but an
already running request can finish after that deadline. Once retries are exhausted
or a permanent error occurs, that batch is dropped. This loss is accepted.

On SIGTERM the API stops accepting requests and releases lazy-model load waiters.
HTTP requests, background jobs and pool cleanup share a **5 s drain bound**. It
then drains PostHog capture for at most **5 s**, flushes both telemetry providers
concurrently for at most **5 s**, and calls the explicitly owned Tokio runtime's
`shutdown_timeout` with **1 s** for detached blocking loaders. The total application
shutdown budget is **16 s** (5 + 5 + 5 + 1), plus scheduling overhead. An in-flight
native model call cannot be forcibly interrupted; the process exits after the
runtime bound instead of waiting indefinitely. The platform should allow more
than 16 s between SIGTERM and SIGKILL to accommodate scheduling overhead and a
full flush. The controller must verify and set the backend's
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` before relying on a full shutdown flush;
no backend drain value is declared in `.railway/railway.ts` today. Railway's
[documented default is 0 s](https://docs.railway.com/variables/reference).
Pending or in-flight records at a hard kill, timeout or process exit are an
accepted loss. Queues are finite and memory-only: overload drops new
records, and a restart loses queued data. There is no application queue. Direct
export therefore has shorter buffering/retry than the collector's 1,000-request
queues and unlimited elapsed retry, no separate collector memory limiter, and
uses uncompressed protobuf rather than the collector's gzip. Local fmt logs stay
unchanged, including when the endpoint is unset or `OTEL_SDK_DISABLED=true`.

The backend also preserves `POSTHOG_HOST` and `POSTHOG_PROJECT_TOKEN` in both
environments for server-side product events. All four backend PostHog/OTLP
variables and every X2 service variable use `preserve()`; values and reference
expressions remain in Railway. Never print variable values while inspecting
configuration.

`.railway/railway.ts` declares the collector only inside
`ctx.isEnvironment('production')`. Never duplicate it into test. Review `railway config plan --environment production` and
`railway config plan --environment test` after every IaC change. **Never apply a
plan that deletes X2 resources or backend telemetry variables.** A mirror-only
change must produce no X2 creates, updates or deletes in either plan. Any
new drift (Clerk variables, backend source/restart settings, volume regions or image
buckets) needs separate review before any apply.

While the collector remains in use, deploy it once its configuration and three variables
are set. From the **worktree root**:

```sh
railway up . --path-as-root --service otel-collector --environment production --ci
```

From the **main checkout root**, plain `railway up` works:

```sh
railway up --service otel-collector --environment production --ci
```

From a Git worktree under `.claude/worktrees/`, the Railway CLI resolves the main
checkout and its ignore rules drop the worktree, so use the first command from the
worktree root; it uploads the worktree explicitly with `. --path-as-root`.

Its Dockerfile watches `infra/otel-collector/**`; Railway's default restart policy
is on failure, with five retries. Verify the submitted deployment reaches
`SUCCESS`, confirm unauthenticated OTLP requests return 401, then verify an
authenticated test log and trace reach PostHog.

To rotate the collector token, generate a fresh random token locally and pipe
it with `railway variable set --stdin` to production collector
`COLLECTOR_BEARER_TOKEN` and both backend `OTEL_EXPORTER_OTLP_HEADERS` variables.
Use `--skip-deploys` while staging, and a production reference to the collector
variable where possible; test needs its own securely supplied value across the
environment boundary. Redeploy collector and both backends together, allowing
for a brief authorization interruption, then verify 401 with the old token and
successful exports with the new one. Never put a token in shell arguments or a
file.

See the [collector guide](../infra/otel-collector/README.md) for routing,
redaction and authentication.

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

`test` mirrors production but is isolated: its own Postgres (pgvector), Redis and `images`
bucket. The backend, Postgres and Redis deployments are ephemeral. The "Deploy backend"
workflow starts Postgres and Redis and waits for their deployments to reach `SUCCESS`, gives
sockets a five-second readiness margin, then deploys the backend. The existing
`scripts/ci/wait-healthy.sh` loop checks `/healthz` and `/readyz` (Postgres, Redis and configured
storage) before seeding and e2e tests. When the `test` job ends, even on failure, it removes the
backend first, then Redis, then Postgres. Each removal runs even if an earlier removal failed;
earlier test failures remain failures.

If an upload has unchanged backend source and Railway marks it `SKIPPED` while nothing is
running, the workflow redeploys from the last uploaded source. Preview app builds (EAS profile
`preview`) use **https://backend-test-70c2.up.railway.app** and can reach it only while a
workflow run holds the backend up. To keep all three services running for measurement,
dispatch `gh workflow run deploy.yml -f ref=<branch> -f keep_test_backend=true`. This input
keeps the dependencies too. The next workflow may use and stop these services, so finish
manual debugging before another run starts.

Both workflows use `scripts/ci/wait_turn.py deploy.yml test railway-integration.yml:test` to
queue by run id across workflows. Ownership lasts through the entire `test` job, including
teardown. A run cancelled or timed out while waiting never starts or stops services. Coordinate
manual CLI work with these runs; a CLI session does not hold that queue.

For debugging, from a linked Railway project with a test-scoped token, start the dependencies
by hand (the helper waits for a new deployment's `SUCCESS`, or leaves an existing `SUCCESS`
deployment alone):

```sh
python3 -I scripts/ci/railway_service.py up Postgres test
python3 -I scripts/ci/railway_service.py up Redis test
```

Image-based services require `railway redeploy --service Postgres --environment test --yes
--from-source --json` after `down` (likewise for Redis). Plain `redeploy` fails with "No
deployment found for service". The `--from-source` response can be `{"success":true}` without
an id; the helper polls `railway deployment list` for a new deployment. The GitHub-source
backend instead uses plain `redeploy --json` and its returned deployment id.

Stop services afterwards in dependency order:

```sh
python3 -I scripts/ci/railway_down.py backend test
python3 -I scripts/ci/railway_service.py down Redis test
python3 -I scripts/ci/railway_service.py down Postgres test
```

`down` removes deployments and keeps stored data. Never use `railway volume delete`: the
volumes are shared between `test` and `production`. The bucket remains available between runs.

The "Railway integration" workflow (`railway-integration.yml`) is **manual dispatch only**.
It starts Postgres and Redis itself, runs both test groups in one owning job, and always stops
Redis then Postgres. `scripts/ci/with-railway-test-services.sh` probes both public TCP proxies
until they accept connections before maintenance and tests; it isolates and cleans up its
throwaway database and Redis logical database, while the workflow owns service deployments.
When using the helper locally, start dependencies first and stop them afterwards as above.

Coverage comparison with `ci.yml`'s `rust-integration` job:

- Railway `api` selects workspace `#[ignore]` tests except binaries `seed`, `seed_clerk`,
  `recognition_vector` and `validation_invite_expiry_and_ip_limits`; `heavy` selects those
  three binaries. Both use the `railway` nextest profile and one test thread.
- `rust-integration` selects **all** workspace `#[ignore]` tests in two partitions, running
  `validation_invite_expiry_and_ip_limits` separately with default rate limits. It provides
  local Postgres+pgvector, Redis and RustFS with all storage variables. In particular,
  `storage::real_upload_reference_and_presigned_download` runs there too; no test requires
  the Railway bucket specifically.
- Removing Railway integration's push and nightly triggers drops that workflow's automatic
  checks of the public proxies, real bucket credentials and deployed service configuration.
  It loses no selected Rust test coverage on backend changes; CI still runs the full set.
  Direct Railway integration checks remain available by manual dispatch. Deploy backend's
  automatic readiness and e2e checks also continue.

Created once with:

```sh
railway environment create test --duplicate production --json
railway bucket create images --region sin --environment test      # test-only bucket (declared in railway.ts)
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
`SKIPPED`, meaning the running deployment already matches. `railway up --ci` never returns after
a `SKIPPED` upload, so the workflow deploys with `scripts/ci/railway_deploy.py`: it uploads with
`--detach` and polls `railway deployment list` until the new deployment is `SUCCESS` or `SKIPPED`
(exit 0) or `FAILED` / `CRASHED` / `REMOVED` (prints the build log, exit 1), with a 30-minute cap.

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

**CI use of the secrets.** Secrets are unavailable to fork pull requests and dependabot runs, so
only those two degrade with a `::notice::`. For same-repo pull requests, pushes and `main` the
`clerk-secrets` gate job of `ci.yml` and `android-e2e.yml` fails with an error naming the
missing secrets, so a blank secret cannot silently drop the Clerk coverage.

| Workflow / job                         | Secrets and variables                                                                                                                                                     | Without the secrets                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `ci.yml` `docker-e2e`                  | `CLERK_PUBLISHABLE_KEY` to Compose; `CLERK_SECRET_KEY` to `apps/backend/scripts/e2e.sh`, which creates a `+clerk_test` user, mints a 10 minute token and deletes the user | Authenticated checks (store, images) skipped |
| `ci.yml` `web-e2e`                     | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (the export embeds it)                                                                   | Fork/dependabot: skipped; else gate fails    |
| `android-e2e.yml` `maestro`, `expo-go` | Backend stack gets both keys; the app build and Metro get `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`                                                                             | Fork/dependabot: skipped; else gate fails    |
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
so fork and dependabot runs (no secrets) skip with a notice while every other run fails when the
secrets are blank. Each job appends a summary (JUnit counts through
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

Deploys are serialized per environment. Production uses the `deploy-railway-production`
concurrency group. The `test` job uses no group: GitHub keeps one pending run per group and
cancels older pending runs, which kept cancelling branch validations. Instead its first step,
`scripts/ci/wait_turn.py`, waits until no `Deploy backend` run with a smaller run id still has its
`test` job queued or running (a FIFO queue; older runs never wait on newer ones).
`.github/workflows/railway-integration.yml`
runs the `#[ignore]` integration tests against the real `test` Postgres, Redis and bucket
(manual, nightly 20:17 UTC and on backend changes to `main`) via
`scripts/ci/with-railway-test-services.sh`: a throwaway database
`it_<epoch>_<run>_<attempt>_<pid>` is created and dropped per run, Redis logical database
15 is flushed afterwards, and the bucket is shared and append-only. Before creating a database,
the script force-drops `it_` databases older than six hours (configurable with
`IT_DB_MAX_AGE_HOURS`) and all legacy `it_` names without a timestamp. It logs each drop
and warns when the total `pg_database_size` exceeds 3.5 GB (3,500,000,000 bytes;
`IT_DB_SIZE_LIMIT_BYTES`), listing the largest databases. This sum does not include all
volume usage, such as WAL. Set the age limit longer than any expected integration run.

When Postgres is available, manually drop abandoned `it_` databases with
`DROP DATABASE "<name>" WITH (FORCE)`; leave other databases and active runs alone.

If the volume is full and Postgres cannot start, the volume cannot be grown: 5000 MB is the
Hobby plan's maximum (`railway config apply` answers "Max size of 5000 MB on current plan").
Test data is disposable, so reset the test data directory instead (done on 2026-11-21):

1. Link the `test` environment. In a scratch copy of `.railway/railway.ts`, give the `Postgres`
   service this start command for `test` only:
   `/bin/sh -c "rm -rf /var/lib/postgresql/data/* /var/lib/postgresql/data/.[!.]*; exec docker-entrypoint.sh postgres"`.
2. `railway config plan --file <copy>` must show that one change and `Environment test`. Apply
   it and wait for "database system is ready to accept connections".
3. Remove the start command from the copy, plan again (one change: the start command back to
   null) and apply it at once. While the command is in place every restart empties the database.
4. The next backend deploy runs the migrations and `scripts/ci/seed-test.sh` seeds the data.

Never use `railway volume delete` for this. `postgres-volume` is one volume with an instance
per environment (the same id in `test` and `production`), so deleting it removes the
production database too. A redeploy can also move the test volume to the service's region;
keep the `region` in `.railway/railway.ts` equal to the live one.

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
`scripts/ci/railway_deploy.py backend` in the `production` job, which `needs` the `test`
job (deploy, seed, e2e). Production deploys are serialized. Turn off
Railway's independent GitHub autodeploy trigger for backend so it cannot bypass
the CI gate. Infrastructure changes go through `railway config plan/apply`, not this workflow.

`RAILWAY_TOKEN` is optional for a green pipeline: when the secret is empty or missing,
the workflow emits a `::notice::` and skips the Railway CLI install, `railway up` and
the smoke test, so `main` stays green before the secret exists.

**Post-deploy smoke.** The repository **variable** `BACKEND_URL` is set to
`https://backend-production-5f5c.up.railway.app` (no trailing path). After `railway up`,
the workflow runs `curl` against `$BACKEND_URL/healthz` and `$BACKEND_URL/readyz`, expecting
HTTP 200, retrying every 10 seconds for up to 30 attempts per endpoint. The job fails if
either never answers 200. Without `BACKEND_URL` this step is skipped with a notice.
Set it under Settings > Secrets and variables > Actions > Variables.

No GitHub job runs EAS, so **EXPO_TOKEN is not required** in GitHub. Configure EAS
account authorization/GitHub linkage in Expo when enabling the existing native
build and Maestro workflows.

### PostHog dashboards

The seven product dashboards, replay playlists, assistant kill switch, saved log views,
store group labels and replay/error project settings are managed by
[`infra/posthog`](../infra/posthog/README.md). Use its offline dry-run in CI and review a
credentialed dry-run before the controller applies changes. The README covers the runtime
secrets file and environment-scoped data verification.

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
