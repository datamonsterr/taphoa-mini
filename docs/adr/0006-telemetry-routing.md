# ADR 0006: OpenTelemetry through one collector to self-hosted Langfuse and PostHog Cloud

Status: Superseded by [ADR 0007](0007-posthog-only-observability.md) · Date: 2026-10-25

## Context

We need LLM traces, evaluations and assistant dashboards (Langfuse), product analytics, logs,
errors and session replay (PostHog), and every signal tied to the person and store. Railway
`test` duplicates the services of `production`, and `.railway/railway.ts` has no
per-environment resources.

## Decision

- The backend instruments with `tracing` bridged to OpenTelemetry (traces and logs) and exports
  OTLP/HTTP to one OTel Collector service. The collector routes assistant spans (`gen_ai.*`,
  scope `taphoa.assistant`) to Langfuse and all traces and logs to PostHog.
- Langfuse (web, worker, ClickHouse, Postgres, Redis, object storage) and the collector run
  once, in the `taphoa-mini` project's `production` environment only. The `test` backend
  exports to the collector's public domain with a bearer token; signals are split by
  telemetry environment (`production`, `test`, `eval`, `local`).
- PostHog is PostHog Cloud US. The mobile app sends product events and session replay with the
  PostHog React Native SDK; the backend sends business events server-side.
- Person identity in every signal is the Clerk user id; the store is a PostHog group and a
  Langfuse trace attribute. Names, emails and phone numbers never go into span or log
  attributes.

## Considered options

- Exporting straight from the backend to both vendors: rejected; routing, redaction and
  credentials would live in application code, and the test environment would need its own
  copies of vendor credentials.
- Self-hosting PostHog: rejected; the hobby deployment needs about 16 GB RAM and is not
  supported for production.
- A Langfuse stack per environment: rejected; it doubles cost for little benefit.

## Consequences

- The Langfuse stack and collector are created outside the IaC file's environment
  duplication. `railway config plan` must never show them as deletions before an apply.
- Langfuse's ClickHouse needs a volume and several GB of RAM; watch Railway cost.
