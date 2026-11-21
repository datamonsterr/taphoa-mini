# Infrastructure cost: phased move to scale-to-zero hosting

Status: Phase A in progress · Date: 2026-11-21 · Decision record: [ADR 0011](../adr/0011-scale-to-zero-hosting.md)

## Goal

Run taphoa-mini for 1 to 10 stores at the lowest possible monthly bill, without slower hot
paths and without a user-visible cold start on ordinary API calls.

- Phase A: stay on Railway and bring the bill from about $41 to the $5 Hobby plan fee.
- Phase B: move to request-billed, scale-to-zero hosting and cancel Railway. Target about $0.

## Baseline (measured 2026-11-21)

| Item                         | Value                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- |
| Railway bill, previous month | $41.32                                                                 |
| Share of bill that is memory | 97% (CPU, egress and volumes together are under $0.50)                 |
| `test` backend               | 3.42 GB average over 30 days, idle. About $34 per month                |
| `production` backend         | 1.23 GB average, CPU peak 0.05 vCPU over 30 days. About $12 per month  |
| `otel-collector`             | 122 MB. About $1.20 per month                                          |
| Postgres, landing, Redis     | 76 MB, 20 MB, 6 MB                                                     |
| Railway prices               | $10 per GB-month of memory, $20 per vCPU-month, $0.15 per GB of volume |
| Hot endpoints today          | upstream p95 9 to 37 ms (`recognition-latency.md`)                     |
| Checkout scan today          | p95 2101 ms end to end, on 8 vCPU                                      |

The bill pays for memory that waits: the backend loads MobileSAM, DINOv2 and the OCR models at
boot and holds them for the life of the process. Traffic is close to zero.

Two faults found the same day, both fixed as part of Phase A:

- The `test` Postgres volume is full, Postgres crash-loops, and the "Deploy backend" workflow
  has failed since 2026-11-07. Production still runs the 2026-11-03 build.
- The `test` backend kept running a 2026-11-03 deployment at about 3 GB. It was stopped on
  2026-11-21.

## Decisions

Owner decisions of 2026-11-21:

1. Phased path: Phase A on Railway first, then Phase B off Railway.
2. The `test` environment becomes ephemeral. The `test` backend runs only while the deploy
   workflow needs it.
3. The agent may merge, deploy and change Railway configuration. It asks before the API URL
   cutover and before deleting or cancelling anything on Railway production.
4. Production data is disposable: there are no customers yet. Phase B starts with an empty
   database and an empty bucket. Nothing is migrated.
5. The recognition models run on the owner's GPU machine if a measurement shows that latency
   and output quality hold (see "Inference on the owner's machine"). The cloud backend keeps
   the lazy CPU models of A2 as the fallback.

## Phase A: Railway at the plan fee

Expected usage after Phase A is about $3 per month, which is inside the $5 that the Hobby plan
includes, so the bill is the $5 fee.

### A1. Ephemeral `test` backend

The "Deploy backend" workflow removes the `test` backend deployment when its `test` job ends,
whatever the result. A `workflow_dispatch` input keeps it for manual measurement.

Acceptance:

- After a workflow run, `railway deployment list -s backend -e test` shows no running
  deployment, and `https://backend-test-70c2.up.railway.app/healthz` does not answer 200.
- The `production` job still runs only after a green `test` job.
- `docs/deploy.md` says that preview app builds reach the `test` backend only while a workflow
  run holds it, and how to keep it up.

### A2. Lazy model lifecycle

The server binds its port before any model loads. Each model family (SAM, DINOv2, OCR) loads on
first use, and unloads after an idle period so the memory returns to the operating system.

- `POST /v1/recognition/warm` loads every family and returns when they are ready. It is
  idempotent and requires a signed-in member.
- A request that arrives while a family loads waits for it. It does not get `503`.
- `MODEL_IDLE_UNLOAD_SECS` sets the idle period (default 900, `0` never unloads).
- `/healthz` and `/readyz` do not depend on models.

Acceptance:

- Time from process start to an accepted request is under 1 s with a reachable database
  (measured, recorded in `recognition-latency.md`).
- Resident memory with all families unloaded is at most 200 MB, measured after one full
  load and unload cycle. Before the change it is 1.06 GB with four decoders.
- Cold load time per family and for all three together is measured on 4 vCPU and recorded.
- Warm latency of scan, segment and receipt OCR is within 5% of the numbers in
  `recognition-latency.md`.
- If resident memory does not fall below 200 MB in process, the report says so with numbers.
  Running inference in a child process that exits when idle is the fallback, decided at review.

### A3. App warms the models

The app calls `POST /v1/recognition/warm` when a screen that leads to a scan, an enrollment or
a receipt opens, without waiting for the answer and without showing an error.

Acceptance: a test proves one warm call per screen entry and none while the screen stays open.

### A4. Telemetry without the collector

The backend exports traces and logs straight to PostHog over OTLP/HTTP. Redaction moves into
the backend: the same keys and digit patterns the collector removes today
(`infra/otel-collector/config.yaml`). The `otel-collector` service is removed from Railway after
production has run one week without it.

Acceptance:

- A trace and a log line from a local run arrive in PostHog with the right environment.
- A unit test proves that authorization, cookie, token and secret attributes, and 9 to 15 digit
  sequences in log bodies, never leave the process.
- With `OTEL_EXPORTER_OTLP_ENDPOINT` unset the backend starts and exports nothing.

### A5. Operations

- Grow the `test` Postgres volume (already in `.railway/railway.ts` since #333), drop the leaked
  `it_*` databases, and get one green "Deploy backend" run so production is current.
- Set `MODEL_IDLE_UNLOAD_SECS` and the telemetry variables per environment.

## Phase B: request-billed hosting

Outline only. Each item gets its own acceptance list after the spike (B0).

| Item | Change                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0   | Spike on Cloud Run in `asia-southeast1`: cold start of a model-free image and of the model image, warm scan latency on 4 and 8 vCPU. Go or no-go.                                |
| B1   | One binary, two roles. `api` (1 vCPU, no models) proxies recognition routes to `ml` (4 to 8 vCPU, models). Both scale to zero.                                                   |
| B2   | Background loops become one idempotent `POST /internal/tick`, called by a scheduler every 5 minutes. The same call keeps an instance warm.                                       |
| B3   | Migrations leave the boot path and run in the deploy workflow. The pool connects lazily.                                                                                         |
| B4   | Work that runs after the response today (thumbnail uploads, analytics, telemetry flush) finishes before the response ends or moves into the tick.                                |
| B5   | Redis is removed. PIN lockout, per-address limits and daily quotas live in Postgres. Burst limits live in memory.                                                                |
| B6   | A new Supabase free Postgres in Singapore (`vector`, `pg_trgm`, `unaccent`), created empty by the migrations. A nightly dump to object storage starts before the first customer. |
| B7   | A new, empty Cloudflare R2 bucket replaces the Railway buckets. The S3 client is already driven by environment variables.                                                        |
| B8   | The landing page moves to a free static host. Integration tests use CI service containers.                                                                                       |
| B9   | Cutover: new API URL in the app and the web build, old URL kept for a transition period, then Railway is cancelled.                                                              |

### Inference on the owner's machine

Decision 5 moves the model work off cloud CPUs. A worker on the owner's machine (GTX 1060 6GB)
holds the models in VRAM and serves stateless inference calls: image in, masks, embeddings or
text out. It has no database and no bucket access. The cloud backend calls it through a tunnel
with a shared secret and falls back to its own lazy CPU models when the worker does not answer.
The worker runs as a user service with CPU and memory limits so that the machine stays usable.

This is gated by a spike that measures, on this GPU, per-model latency, VRAM, CPU and memory use,
and output parity with the CPU provider. Its results and the task list are added here after
the spike.

`GET /v1/events` has no caller in the app today (only `packages/e2e` uses it). B5 decides
whether it stays as an in-process stream or goes.

Prices behind the target, read from vendor pages on 2026-11-21:

- Cloud Run request-based billing: idle instances are not billed. The monthly free tier is a
  credit worth 180,000 vCPU-seconds and 360,000 GiB-seconds at Tier 1 prices. Singapore is
  Tier 2, so the credit buys about 128,600 vCPU-seconds there.
- Supabase free: 500 MB database, always on, paused after 7 days of low activity.
- Cloudflare R2 free: 10 GB, no egress charge.

## Acceptance criteria for the program

- Phase A: the Railway invoice for the first full billing period after Phase A is $5.
- Phase B: the total monthly bill across all vendors is at most $1 with up to 10 stores.
- Hot endpoints keep an upstream p95 of at most 40 ms on a warm instance.
- Warm checkout scan p95 is at most 2101 ms end to end.
- An ordinary API call never waits for a model to load.
- Production data is not carried over (decision 4). The nightly database dump works before the
  first customer signs up.

## Out of scope

- Running recognition or OCR on the phone.
- Rewriting the backend for Cloudflare Workers, or splitting it into per-request functions.
- AWS Lambda and Fly.io (see ADR 0011 for the reasons).
- Changing recognition models. PR #301 does that and is separate.
- CI runner cost.

## Risks

- Unloading models may not return memory with the system allocator. A2 measures it and names
  the fallback.
- PR #301 changes the recognition models. A2 keeps its change inside the model holder so
  either branch can rebase on the other.
- Free tiers change. Phase B keeps every service behind standard interfaces (a container, a
  Postgres URL, an S3 endpoint) so a move back is a configuration change.
- A free database has no managed backups. B6 adds a nightly dump before the cutover.
