#!/usr/bin/env bash
set -euo pipefail
collector_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
docker run --rm \
  --mount "type=bind,src=$collector_dir/config.yaml,dst=/config.yaml,readonly" \
  -e COLLECTOR_BEARER_TOKEN=validation-token \
  -e LANGFUSE_OTLP_ENDPOINT=http://langfuse-web.railway.internal:3000/api/public/otel \
  -e LANGFUSE_PUBLIC_KEY=public \
  -e LANGFUSE_SECRET_KEY=secret \
  -e POSTHOG_PROJECT_TOKEN=validation-token \
  otel/opentelemetry-collector-contrib:0.163.2 validate --config=/config.yaml
