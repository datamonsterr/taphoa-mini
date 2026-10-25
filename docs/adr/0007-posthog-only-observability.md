# ADR 0007: PostHog only for LLM observability, product analytics, logs and traces

Status: Accepted · Date: 2026-10-25 · Supersedes [ADR 0006](0006-telemetry-routing.md)

## Context

ADR 0006 split telemetry between self-hosted Langfuse (assistant traces, evaluations,
assistant dashboards) and PostHog Cloud (product analytics, logs, errors, replay). PostHog LLM
analytics now covers traces, generations, tool spans, tokens, latency, cost, per-person views and
online LLM-as-judge evaluations, and joins them with product events, replay, logs and errors for
the same person and store. Langfuse needed five extra Railway services (web, worker, ClickHouse,
Postgres, Redis) plus a bucket. The owner chose one tool.

## Decision

- No Langfuse. The Langfuse Railway services, volumes and bucket are removed.
- The backend keeps OpenTelemetry (`tracing` bridged to OTLP traces and logs) and exports to the
  OTel Collector in Railway `production`. The collector keeps bearer auth and redaction and
  routes all traces and logs to PostHog.
- Assistant LLM observability uses PostHog LLM analytics events (`$ai_trace`, `$ai_span`,
  `$ai_generation`) captured by the backend PostHog client. Each event carries the Clerk user id
  as `distinct_id`, the `store` group, and the assistant thread id as `$ai_session_id`. Manual
  capture is chosen over PostHog's AI OTLP endpoint (`/i/v0/ai/otel`) because that endpoint takes
  the distinct id from a resource attribute, which is per process, not per request. X3 may switch
  only after verifying per-span identity on that endpoint.
- User feedback, proposed-action outcomes, quota hits and golden-set scores are PostHog events.
  Use PostHog's current LLM feedback and metric event names where they exist; otherwise use the
  custom events in the telemetry contract.
- Golden-set runs: the harness emits one event per case and scorer plus a run summary, and
  writes a results file in the repo. PostHog insights compare runs by model and use case.
- Online LLM-as-judge uses PostHog evaluations on sampled production generations when the plan
  offers them; otherwise the nightly harness judges a sample of production traces.

## Consequences

- One vendor for every signal; a person's assistant turns, sales, replays and errors are joined
  without manual id matching.
- Free tier: 100K `$ai_*` events per month with 30-day retention. The repo results files are the
  long-term record of eval runs.
- No dataset-run comparison UI; the harness report and PostHog insights replace it.
- Less infrastructure and cost on Railway.
