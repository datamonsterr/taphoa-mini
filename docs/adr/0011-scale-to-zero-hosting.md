# ADR 0011: Pay for requests, not for waiting memory

Status: Accepted for Phase A; Phase B is accepted in direction and gated by a spike · Date: 2026-11-21 · Spec: `docs/specs/serverless-cost.md`

## Context

Railway bills memory by the minute. On 2026-11-21 the bill was about $41 per month and 97% of
it was memory held by two idle backends: the `test` backend at 3.4 GB and the `production`
backend at 1.2 GB. Both load three model families at boot and keep them. Production CPU peaked
at 0.05 vCPU in 30 days. The product has 1 to 10 stores.

ADR 0001 chose Railway with one always-on backend, Postgres and Redis. ADR 0006 put an
OpenTelemetry Collector in front of PostHog for redaction, retries and to keep PostHog
credentials out of `test`.

## Decision

1. The backend holds models only while it uses them. It binds its port first, loads each model
   family on first use and unloads it when idle.
2. The `test` backend exists only during a deploy workflow run.
3. The collector is removed. The backend redacts and exports to PostHog itself. This supersedes
   the routing decision of ADR 0006. The backend already holds the PostHog project token in
   both environments, so the credential argument no longer applies.
4. After Phase A, hosting moves to services that bill per request and scale to zero: Cloud Run
   for the backend, Supabase for Postgres and Cloudflare R2 for images. Redis is removed. This
   supersedes the hosting row of ADR 0001 once the Phase B spike passes.

## Options weighed

| Option                              | Monthly floor     | Why not, or why                                                                                                                                                |
| ----------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway as is                       | about $41         | pays for idle memory                                                                                                                                           |
| Railway with lazy models (Phase A)  | $5 plan fee       | smallest change, no cold start on ordinary calls; chosen as the first step                                                                                     |
| Cloud Run + Supabase + R2 (Phase B) | about $0          | idle instances are free, one instance serves concurrent requests, up to 8 vCPU for scans, the Dockerfile is reused; chosen as the end state                    |
| AWS Lambda                          | about $0          | one request per environment, so a burst of calls starts several environments that each load models; new accounts have reduced memory limits; no Rust SnapStart |
| Fly.io Machines with suspend        | $0 only under $5  | suspend keeps loaded models and resumes in a few hundred ms, but there is no free tier, the waiver ends at $5.00 and suspend is limited to 2 GB of memory      |
| Cloudflare Workers (Rust to WASM)   | $0, or $5 for CPU | no cold start, but `sqlx`, the S3 client and ONNX do not run there; a rewrite of the whole backend                                                             |
| Cloudflare Containers               | $5 (Workers Paid) | same floor as Railway with more moving parts                                                                                                                   |
| Recognition on the phone            | $0                | removes the model server, but latency on low-end phones and the web build are unproven                                                                         |

## Consequences

- An ordinary API call never waits for a model. The first scan after an idle period waits for
  the load unless the app warmed the models when the screen opened.
- Request-billed hosts throttle CPU between requests. Background loops, work that continues
  after a response, and telemetry batching must become request-scoped. Phase B does this.
- A long-lived stream holds an instance and is billed for its whole duration. The assistant
  stream stays (it is bounded by model timeouts). `GET /v1/events` is reviewed in Phase B.
- Free tiers carry limits that paid Railway did not: a 500 MB database with no managed backup,
  and a pause after 7 days without activity. The spec adds a nightly dump and a scheduled call.
- Cold starts remain after a deploy and when the host recycles an instance. The Phase B spike
  measures them before any production move.
