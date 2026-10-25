# OpenTelemetry Collector

Pinned image: `otel/opentelemetry-collector-contrib:0.163.2`.

The backend sends OTLP/HTTP with `Authorization: Bearer <COLLECTOR_BEARER_TOKEN>`
to port 4318. The receiver listens on `[::]:4318` for Railway private IPv6 and
IPv4 clients. Production uses `http://otel-collector.railway.internal:4318`;
the test backend uses the collector's public HTTPS domain.

```text
OTLP/HTTP + bearer authentication
  ├─ traces → memory_limiter → redact → resource defaults
  │    ├─ assistant filter → Langfuse roots + environment → batch → Langfuse
  │    └─ batch → PostHog /i/v1/traces (all spans)
  └─ logs → memory_limiter → redact → resource defaults → batch → PostHog /i/v1/logs
```

Langfuse receives only spans with scope `taphoa.assistant` or a
`gen_ai.operation.name` attribute. For `invoke_agent`, its copy of the span has
an empty parent span ID, making each assistant turn a root. Child parent IDs and
trace IDs remain intact; PostHog retains the original parent relationships.
`langfuse.environment` is copied from the resource when missing on the span.

Every pipeline removes span, log and resource attributes matching authorization,
any key containing `cookie`, and keys equal to `token`/`secret` or ending in
`.token`/`.secret` (case insensitive). String log bodies mask 9–15 digit sequences
with `[REDACTED]`; other body types pass through. Missing
`deployment.environment.name` becomes `unknown`; existing values stay intact.

Both exporters use protobuf and gzip in production, a 1,000-request memory
queue per signal pipeline, four consumers, and exponential retry backoff from
1s to 30s with no elapsed retry limit. Short retryable vendor outages are buffered
and retried. Queues are finite and memory-only: sustained overload, permanent
HTTP failures, and collector restarts can lose data. The memory limiter uses a
256 MiB hard limit and a 64 MiB spike allowance. Self-telemetry logs at info;
metrics are disabled and no metrics listener is opened.

## Environment variables

| Variable                 | Value                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `COLLECTOR_BEARER_TOKEN` | Required shared inbound bearer token                                                                               |
| `LANGFUSE_OTLP_ENDPOINT` | Required base URL, e.g. `http://langfuse-web.railway.internal:3000/api/public/otel`; exporter appends `/v1/traces` |
| `LANGFUSE_PUBLIC_KEY`    | Required Basic auth username                                                                                       |
| `LANGFUSE_SECRET_KEY`    | Required Basic auth password                                                                                       |
| `POSTHOG_HOST`           | Optional base URL; defaults to `https://us.i.posthog.com`; omit trailing slash                                     |
| `POSTHOG_PROJECT_TOKEN`  | Required PostHog bearer token                                                                                      |

Langfuse requests also carry `x-langfuse-ingestion-version: 4`. Supply credentials
at runtime; do not put them in the image or tracked files.

## Local use and checks

Run these commands from the repository root. Put the runtime variables above in
an untracked local env file, replacing the example path below.

```sh
docker build -f infra/otel-collector/Dockerfile -t taphoa-otel-collector .
docker run --rm -p 4318:4318 --env-file /path/to/collector.env taphoa-otel-collector

# Validate the production config with dummy credentials (no vendor requests).
infra/otel-collector/validate.sh

# Python 3 stdlib only; Linux Docker host networking, port 4318 must be free.
python3 -m unittest discover -s infra/otel-collector/tests -v

pnpm exec prettier --check .github/workflows/ci.yml infra/otel-collector
```

The tests run the pinned image with `config.yaml` followed by
`tests/override.yaml` via multiple `--config` flags. The override only selects
JSON, disables compression and shortens batching. Export URLs and dummy secrets
come through the same environment variables as production. Local recording
sinks return a 503 once per endpoint to prove retry delivery, then assert routing,
parent relationships, authentication, redaction and environment defaults. Tests
skip with a reason if Docker is absent or its daemon is unavailable, and remove
the test container on success or failure. They never contact vendors.

Railway builds from the repository root with Dockerfile path
`infra/otel-collector/Dockerfile`; the adjacent `Dockerfile.dockerignore` limits
the context to collector files. Controller deployment placeholder (not executed
by this task):

```sh
railway up --service otel-collector --environment production
```

## Pinned documentation findings

The [0.163.2 distribution manifest](https://github.com/open-telemetry/opentelemetry-collector-releases/blob/v0.163.2/distributions/otelcol-contrib/manifest.yaml)
pins the relevant component modules to **v0.163.0**. The core and contrib repos
have no v0.163.2 tag; use the component READMEs at the actual module tag:

- [OTLP receiver](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.163.0/receiver/otlpreceiver/README.md),
  [bearer authentication](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.163.0/extension/bearertokenauthextension/README.md),
  [Basic authentication](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.163.0/extension/basicauthextension/README.md).
- [Filter](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.163.0/processor/filterprocessor/README.md)
  supports `trace_conditions`; matching conditions **drop** telemetry.
- [Transform](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.163.0/processor/transformprocessor/README.md),
  [OTTL functions](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.163.0/pkg/ottl/ottlfuncs/README.md)
  and [span paths](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.163.0/pkg/ottl/contexts/ottlspan/README.md)
  support `delete_matching_keys`, `replace_pattern` and setting `span.parent_span_id`
  using `SpanID(0x0000000000000000)`.
- [Resource](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.163.0/processor/resourceprocessor/README.md),
  [memory limiter](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.163.0/processor/memorylimiterprocessor/README.md),
  [batch](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.163.0/processor/batchprocessor/README.md)
  and [exporter helper](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.163.0/exporter/exporterhelper/README.md):
  batch remains supported and is placed after filtering and transformations.
  Exporter queue batching is also available, but is disabled by default. We keep
  the contract's explicit batch processor (1s, 512 items, maximum 1,024) and avoid
  batching twice.
- [OTLP HTTP exporter](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.163.0/exporter/otlphttpexporter/README.md)
  supports the endpoint, header, encoding, compression, retry and queue settings
  used here. `otlp_http` is the current exporter type name.
  `${env:POSTHOG_HOST:-https://us.i.posthog.com}` is accepted
  by the pinned image and exercised without `POSTHOG_HOST` in `validate.sh`.
