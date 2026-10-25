# Langfuse on Railway

The `taphoa-mini` production environment hosts one shared Langfuse v4 stack and
OTel Collector. The test backend sends to that collector; it has no Langfuse
services of its own. Telemetry environments separate production, test, eval and
local signals. See [ADR 0006](../../docs/adr/0006-telemetry-routing.md) and the
[deployment guide](../../docs/deploy.md#telemetry).

## Resources

| Service               | Image / build                                  | Region | Persistent storage / exposure                                                                   |
| --------------------- | ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `langfuse-postgres`   | `ghcr.io/railwayapp-templates/postgres-ssl:18` | `sfo`  | `postgres-volume-wZbV`, 5000 MB at `/var/lib/postgresql/data`; private endpoint `postgres-4xnr` |
| `langfuse-redis`      | `redis:8.2`                                    | `sfo`  | `redis-volume-53l7`, 5000 MB at `/data`; private only                                           |
| `langfuse-clickhouse` | `clickhouse/clickhouse-server:26.4.5`          | `sfo`  | `langfuse-clickhouse-volume`, 5000 MB at `/var/lib/clickhouse`; private ports 8123 / 9000       |
| `langfuse-web`        | `langfuse/langfuse:4.70.0`                     | `sfo`  | Public HTTPS to port 3000; no volume                                                            |
| `langfuse-worker`     | `langfuse/langfuse-worker:4.70.0`              | `sfo`  | Private, port 3030; no volume                                                                   |
| `otel-collector`      | `infra/otel-collector/Dockerfile`              | `sfo`  | OTLP/HTTP port 4318; private and authenticated public ingress; no volume                        |

The private S3-compatible Railway bucket `langfuse` is in `sin`. Event uploads,
media uploads and batch exports use prefixes `events/`, `media/`, `exports/`.
Batch export is disabled initially; its storage settings are still populated.

Web UI: <https://langfuse-web-production-dac5.up.railway.app>.
Collector public base: <https://otel-collector-production-ce86.up.railway.app>.
Generated domains stay in Railway rather than the IaC graph. Database helpers
retain their managed mounts; all three named volumes are mirrored explicitly.

## Headless initialization and bootstrap

[Langfuse headless initialization](https://langfuse.com/self-hosting/administration/headless-initialization)
creates resources on startup if they do not already exist. On `langfuse-web`,
`LANGFUSE_INIT_ORG_ID`, `LANGFUSE_INIT_ORG_NAME`, `LANGFUSE_INIT_PROJECT_ID` and
`LANGFUSE_INIT_PROJECT_NAME` are all `taphoa`. The initial admin is the project
owner: `LANGFUSE_INIT_USER_EMAIL` is the owner's email and the user name is
`taphoa admin`. The generated password lives only in the Railway variable
`LANGFUSE_INIT_USER_PASSWORD`. Signup is disabled with `AUTH_DISABLE_SIGNUP=true`.

`bootstrap.sh` is an **operator-run variable bootstrap**, not a provisioning or
rotation script. First provision the named services, volumes, bucket and domains
with reviewed infrastructure changes; database provisioning supplies Postgres and
Redis credentials. Set the backend's PostHog variables separately. Link the local
checkout to `taphoa-mini` / `production`, then run from the repository root:

```sh
railway link --project taphoa-mini --environment production
LANGFUSE_OWNER_EMAIL='<owner-email>' bash infra/langfuse/bootstrap.sh production
```

The script refuses other environments and verifies the linked project/environment
before writing. It fills only missing variables, so reruns retain existing keys,
passwords and operator settings. It stages variables with `--skip-deploys`; deploy
web, worker and collector separately after dependencies are healthy. It uses the
controller's variable set plus the runtime host/ports and collector wiring. It
keeps generated secrets and bucket credentials in memory, sends values through
`railway variable set --stdin`, suppresses CLI diagnostics that might echo values,
and prints only service/variable names. It never writes a local secrets file.
Do not run with shell tracing or add commands that print variable values.

## References and generated secrets

Every X2 variable is `preserve()` in `.railway/railway.ts`, including non-secret
settings. Railway holds the values and reference expressions.

| Variables                                                                                             | Source                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Web/worker `DATABASE_URL`                                                                             | Reference to `langfuse-postgres.DATABASE_URL`                                                                             |
| Web/worker `REDIS_CONNECTION_STRING`                                                                  | Reference to `langfuse-redis.REDIS_URL`                                                                                   |
| `CLICKHOUSE_URL`, `CLICKHOUSE_MIGRATION_URL`                                                          | ClickHouse private-domain reference, HTTP 8123 / native 9000                                                              |
| Web/worker `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`                                                   | References to ClickHouse variables; password generated locally                                                            |
| `NEXTAUTH_URL`                                                                                        | Web's Railway public-domain reference with HTTPS                                                                          |
| Web `NEXTAUTH_SECRET`, `SALT`, `ENCRYPTION_KEY`                                                       | Generated locally; worker references the web values                                                                       |
| `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`, `LANGFUSE_INIT_PROJECT_SECRET_KEY`, `LANGFUSE_INIT_USER_PASSWORD` | Locally generated API key pair and admin password, retained in Railway                                                    |
| `LANGFUSE_S3_{EVENT_UPLOAD,MEDIA_UPLOAD,BATCH_EXPORT}_*`                                              | Bucket API credentials and endpoint/region/name copied securely in memory; prefixes and path-style flag are configuration |
| Collector `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`                                                | References to web's initial project keys                                                                                  |
| Collector `LANGFUSE_OTLP_ENDPOINT`                                                                    | Web private-domain reference, `http://${{langfuse-web.RAILWAY_PRIVATE_DOMAIN}}:3000/api/public/otel`                      |
| Collector `COLLECTOR_BEARER_TOKEN`                                                                    | Locally generated random token                                                                                            |
| Collector `POSTHOG_HOST`, `POSTHOG_PROJECT_TOKEN`                                                     | References to production backend variables                                                                                |

`HOSTNAME=::` and `PORT=3000` (web) / `3030` (worker) bind the HTTP
servers on IPv6 for Railway private networking; `::` also accepts IPv4.
`CLICKHOUSE_CLUSTER_ENABLED=false` selects the single-node topology.
`TELEMETRY_ENABLED=false` disables Langfuse's own usage telemetry. Secrets must
never use `ctx.randomString`, which is deterministic, or appear in Git, shell
arguments, logs or documentation.

## Rotation

Create a replacement Langfuse project API key in the UI, update the collector's
public/secret key variables securely using stdin, redeploy the collector, verify
an assistant trace, then revoke the old key. Updating `LANGFUSE_INIT_PROJECT_*`
alone does not rotate keys in an existing project. Likewise, reset an existing
admin password through Langfuse; changing the init password only affects initial
creation. Update its Railway copy securely if retaining it for recovery.

For ClickHouse/Postgres/Redis credentials, coordinate the database credential
change and Railway variable update, then redeploy web and worker so references
resolve again. Rotate bucket credentials with a coordinated update to all three
S3 variable families on both services. Verify ingestion and media access before
revoking old credentials. Rotating `NEXTAUTH_SECRET` invalidates sessions; keep
web and worker synchronized. Treat `SALT` and `ENCRYPTION_KEY` as durable keys:
changing them can break API-key verification or access to encrypted data; follow
Langfuse's supported migration procedure and take backups first.

For the collector bearer token, follow the
[deployment guide](../../docs/deploy.md#telemetry). Bootstrap preserves existing
variables and is intentionally unsuitable for rotation.

## ClickHouse operations and cost

Keep ClickHouse and Postgres in UTC. Check `SELECT timezone()` on ClickHouse;
it must return `UTC`. Non-UTC settings can produce missing or incorrect results.
The application user needs table reads/writes, retention update/delete rights,
and DDL/index grants for startup migrations. Langfuse v4 also reads system parts,
mutations, tables, processes and query logs, and historic backfills require
scratch-table maintenance grants. Audit the exact grants against the
[ClickHouse permissions documentation](https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse#user-permissions)
before upgrades; a read/write-only account is insufficient. Keep default access
management enabled on this self-managed instance.

ClickHouse can consume several GB of RAM during merges, ingestion or migrations;
watch Railway memory, restarts, CPU, volume usage and billing. This stack uses a
single node without redundancy. Monitor all three 5000 MB volumes and the bucket;
set retention in Langfuse and budget for growth. The `sfo` services and `sin`
bucket also introduce cross-region latency and transfer costs.

## Image upgrades

Back up Postgres, ClickHouse and bucket data and test restoration first. Read
Langfuse release/migration notes and the target ClickHouse compatibility rules.
Update both Langfuse images together to the same pinned version in the IaC file;
update the ClickHouse pin separately when required. Do not use floating tags.
Review plans for **both** environments: production must preserve all X2 resources,
and test must not create them. Never apply a plan that deletes X2 resources or
telemetry variables; resolve unrelated destructive drift separately too.

Roll out through a reviewed operator change, watch startup migrations and worker
health, check `/api/public/health`, log in to the UI, and send a trace through the
collector. A container rollback may not undo database migrations; use the tested
backup/restore procedure if a migration is incompatible. Keep image pins and
operator documentation aligned after rollout.
