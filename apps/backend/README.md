# Tạp Hóa Mini backend

Rust stable workspace: `taphoa-api` (axum) and `taphoa-recognition` (SAM ONNX).
This is the monorepo skeleton described in [the accepted spec](../../docs/specs/monorepo-setup.md).
There are no catalog, payment, embedding, or vector-search features.

From `apps/backend`:

```sh
cp .env.example .env
./scripts/fetch-onnxruntime.sh
./scripts/fetch-models.sh
# Edit .env, including the absolute ORT_DYLIB_PATH printed above.
set -a; . ./.env; set +a
cargo run --bin taphoa-api
```

Use Postgres with pgvector and Redis 7. `DATABASE_URL` and `REDIS_URL` configure
connections. The API runs embedded SQLx migrations before serving when Postgres is
configured; a configured but unreachable service fails startup. If URLs are omitted,
the process starts with readiness reporting the missing dependencies. `stores` has
UUID identity, required name, and a timestamp; the only extension is `vector`.

`PORT` defaults to 8080. Both SAM path variables must be set together. With neither
set, or both files absent, segmentation returns 503. A missing file, invalid model,
or missing runtime is reported on first use. No model loads or warms up before serving. `RUST_LOG` controls tracing;
`LOG_FORMAT=json` enables JSON logs and is the Docker default. SIGTERM/Ctrl-C drains
requests and closes the Postgres pool. Configuration is environment-only; the binary
does not automatically read `.env`.

SAM, DINOv2 and OCR load independently on first use in blocking tasks. Concurrent callers
share one load and wait up to 120 seconds; load failure/timeout returns 503 with
`Retry-After: 1`. `/healthz` and `/readyz` never wait for models. Inference still uses
the existing admission limits. `MODEL_IDLE_UNLOAD_SECS` defaults to `900`; `0` disables
unloading. A family unloads only after its last inference lease finishes and it has
been idle for that period (checked at most every 30 seconds). Linux glibc releases
unused allocator pages with `malloc_trim(0)` after session destruction.

`POST /v1/recognition/warm` requires a signed-in store member and loads all three
families concurrently. It returns `200` with `{sam, dinov2, ocr}`, each containing
`load_ms` (the last load duration), `already_loaded` (ready when this call arrived),
and `backend` (`local` or `remote`).
It is idempotent and limited to six requests per member per minute. Unconfigured
families return 503. Use it on entry to a camera/receipt screen to overlap model
loading with preparation.

Set both `INFERENCE_URL` and `INFERENCE_TOKEN` (at least 32 characters) to send recognition
to the owner-hosted `taphoa-infer` worker. Leave both unset for local inference. The worker
uses a separate bearer token from Clerk. `INFERENCE_URL` requires HTTPS except for
loopback hosts (`localhost`, 127.0.0.0/8 and ::1). `INFERENCE_ALLOW_PLAINTEXT=1` is only
for a transport that is already encrypted, such as a private WireGuard network;
otherwise non-loopback HTTP fails startup. Worker health is read in chunks and rejected
as soon as it exceeds 4096 bytes, including responses without Content-Length.
The HTTP/1 client allows 3 s for TCP plus TLS connection setup, retains one idle
connection for 90 s and enables TCP keepalive after 30 s. The existing 10 s trait-call
budget and remaining request deadline still bound inference. A background monitor runs
immediately and every 15 s with a 2 s health timeout to keep a connection warm and drive
the shared circuit. The circuit starts open, closes on healthy worker checks and opens
on failed checks or user-call transport errors, timeouts and 5xx responses. Open-circuit
calls go directly to the existing lazy CPU fallback; user calls never probe recovery.
Worker 4xx responses retain their status and do not trigger fallback. Warm reads the
circuit state and leaves local models unloaded. Local fallback models still unload
after `MODEL_IDLE_UNLOAD_SECS`. Model-free backend images need reachable worker inference;
if both are unavailable they return retryable 503. Debug logs record remote operation,
duration and outcome; info logs record each breaker state change with its reason and
each worker `/v1/` request with route, status, bytes received and duration. Fallback logs
record `backend` and `reason`, without tokens or images. Receipt OCR uses a generous
512-box / 16 Mi-pixel total crop cap; exceeding it returns a 422 client error.
The worker admits at most 32 HTTP connections before authentication, closes excess
sockets immediately, and limits headers to 8 KiB / 32 fields with a 3 s deadline once
a request head starts. Idle keep-alive defaults to 120 s, configured through the worker's
`INFERENCE_IDLE_KEEPALIVE_SECS`. Cancellation stops further model batches/prompts within
the 10 s request budget. An engine panic marks health unready and exits for restart.
Its unit uses `MemoryHigh=infinity`, `MemoryMax=2G`, `MemorySwapMax=0` and
`CPUQuota=200%`; the hard limit remains while worker pages cannot be swapped out.
The final scoped GPU check measured 1145.6 MiB RSS, zero swap and 1522 MiB VRAM;
scan/segment/receipt p50 was 674.5 / 338.3 / 332.6 ms over 20 warm calls each,
within 5% of the earlier results on this shared host.

See [worker installation and operation](../../infra/inference-worker/README.md) and
[measurements](../../docs/specs/recognition-latency.md#inference-worker).

### Authentication (Clerk)

Identity is Clerk ([ADR 0004](../../docs/adr/0004-clerk-identity.md),
[contract](../../docs/specs/assistant/auth-clerk.md)). Protected routes take
`Authorization: Bearer <Clerk session JWT>`; the backend verifies it (RS256) against the
instance JWKS and makes no Clerk call per request. `X-Store-Id` picks the store when the Clerk
user has several memberships (optional with exactly one). The backend issues no tokens and keeps
no refresh tokens, recovery codes or sessions; `JWT_SECRET` is no longer read.

| Variable                         | Required | Meaning                                                                             |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `CLERK_PUBLISHABLE_KEY`          | yes\*    | Gives the Frontend API host: issuer `https://<host>`, JWKS `/.well-known/jwks.json` |
| `CLERK_SECRET_KEY`               | no       | Backend API key for profile reads (and `scripts/e2e.sh`, below); a secret           |
| `CLERK_API_URL`                  | no       | Backend API base URL (default `https://api.clerk.com`)                              |
| `CLERK_AUTHORIZED_PARTIES`       | no       | Comma-separated origins allowed in the token's `azp` claim                          |
| `CLERK_ISSUER`, `CLERK_JWKS_URL` | no       | Override the values derived from the publishable key (tests point them at a stub)   |

\*Startup fails unless an issuer can be derived: set `CLERK_PUBLISHABLE_KEY` or `CLERK_ISSUER`.
An empty or whitespace-only `CLERK_*` value counts as unset. Without `CLERK_SECRET_KEY` the
profile in `GET /v1/me` is `null`. The publishable key is public by design; `.env.example`
defaults to the development instance key. Never commit the secret key; see
[deploy.md](../../docs/deploy.md#clerk-identity) for where each value lives.

| Endpoint              | Result                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`        | 200 `{"status":"ok"}`, without dependency checks                                                                        |
| `GET /readyz`         | 200 after `SELECT 1` and Redis `PING`; otherwise 503 with `dependencies` naming `postgres`/`redis`/configured `storage` |
| `POST /v1/images`     | multipart `image`, optional `store_id`; stores JPEG/PNG/WebP; 201 with reference metadata and a presigned URL           |
| `GET /v1/images/{id}` | 200 metadata with a fresh presigned URL; 404 unknown                                                                    |
| `POST /v1/segment`    | multipart field `image`; JSON array of `{bbox:[x,y,w,h],score,area}`; 503 without a model                               |

```sh
curl -F image=@tests/fixtures/sample.png http://localhost:8080/v1/segment
```

Segmentation uploads are limited to 10 MiB including multipart framing. SAM decodes PNG/JPEG
with dimensions capped at 4096 by 4096 and bounded decoder allocations. Bad images,
missing/duplicate/unexpected fields return 400; oversized uploads return 413. One
inference runs at a time on `spawn_blocking`; excess requests return 503. CORS is
permissive for the unauthenticated skeleton.

SAM resizes the longest side to 1024, normalizes RGB, and zero-pads bottom/right.
The encoder runs once per image. A foreground point plus a padding point is decoded
for each cell of an 8 by 8 grid; masks use original image dimensions. Foreground
logits above zero determine pixel area and bounding boxes. Filters default to
predicted IoU >= 0.88, area >= 64 pixels, area <= 95% of the image, and bbox NMS
at IoU 0.7. This is coarse automatic segmentation, not a tuned product detector.
`YoloSegmenter` explicitly returns `not implemented (phase 2)`. Router tests inject
`MockSegmenter`; production configuration never selects it.

The implementation follows the preprocessing and six decoder tensors from
[AndreyGermanov/sam_onnx_rust](https://github.com/AndreyGermanov/sam_onnx_rust/blob/main/src/main.rs),
using the current [ort 2 API](https://docs.rs/ort/2.0.0-rc.15/ort/).
The [ort linking guide](https://ort.pyke.io/setup/linking) recommends runtime loading;
this workspace deliberately uses `load-dynamic` with API 23, disables automatic
binary downloads, and ships Microsoft's ONNX Runtime 1.23.2 shared library. Local
Linux x86-64 setup uses the checksum-verified runtime helper. Other platforms must
install a compatible runtime >=1.23 and set `ORT_DYLIB_PATH` themselves.

Model downloads: [MobileSAM ONNX](https://huggingface.co/Acly/MobileSAM) and
[DINOv2-small ONNX](https://huggingface.co/onnx-community/dinov2-small) at the pinned
revisions in `scripts/fetch-models.sh` (see `docs/specs/recognition-latency.md` for why
not SAM ViT-B). The fetch script checks pinned SHA-256 hashes before an atomic rename, prints checksums, and reuses
verified files. Weights, runtime downloads, and Cargo artifacts are gitignored.
`tests/fixtures/sample.png` is an original generated two-rectangle test image.

Validation and root Turborepo integration:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo check --all-targets
cargo test
# Explicitly run ignored integration tests; missing configuration prints a skip message.
# Start local services from root: docker compose up -d --wait postgres redis storage
# Export DATABASE_URL, REDIS_URL and all five AWS_* variables from .env.example.
DATABASE_URL=postgres://taphoa:taphoa@localhost:55432/taphoa \
REDIS_URL=redis://localhost:56379 cargo test -p taphoa-api --test readiness --test storage -- --ignored --nocapture
# Runs encoder + all 64 decoder prompts when model files exist; prints SKIP otherwise.
cargo test -p taphoa-recognition --test model -- --nocapture
BASE_URL=http://localhost:8080 ./scripts/e2e.sh
```

`package.json` exposes `lint`, `format`, `format:check`, `typecheck`, `test`,
`test:integration`, `test:e2e`, and `build` for root Turborepo commands. The HTTP smoke
script checks health/readiness, segmentation and image upload/metadata/download by default; set `EXPECT_SEGMENT_STATUS=503` (legacy `SEGMENT_EXPECTED_STATUS` also works)
only when intentionally testing a model-free image. Set `EXPECT_IMAGES=0` only for
intentional storage-less smoke runs; CI always tests image upload/download. Python 3,
curl and cmp are required by the smoke script. Missing readiness fails the smoke.

The authenticated checks (store creation and the image round trip) need `CLERK_SECRET_KEY`, the
Clerk Backend API key of the instance the backend trusts. The script creates a throwaway
`+clerk_test` user, mints a 10 minute session token and deletes the user on exit. Without the
key it prints a notice and skips only those checks (fork and dependabot runs); health,
readiness and segmentation still run. `CLERK_API_URL` overrides the Backend API base URL. The
key and the token are never printed; keep `set -x` off.

```sh
CLERK_SECRET_KEY="$(grep '^CLERK_SECRET_KEY=' ~/.config/taphoa-mini/secrets.env | cut -d= -f2-)" \
BASE_URL=http://localhost:8080 ./scripts/e2e.sh
```

Build **from repository root**, with the Dockerfile-specific ignore file keeping the
context limited to backend source:

```sh
docker build -f apps/backend/Dockerfile -t taphoa-backend .
# Fast image without model downloads; runtime library is still included:
docker build --build-arg SKIP_MODELS=1 -f apps/backend/Dockerfile -t taphoa-backend .
docker run --rm -p 8080:8080 taphoa-backend
curl http://localhost:8080/healthz
```

The image uses cargo-chef dependency caching, a release binary, Debian slim, and UID 10001. To make readiness pass, supply reachable `DATABASE_URL` and `REDIS_URL` to
`docker run` (container localhost is separate from host localhost). To test inference
in a skipped-model image, mount a populated models directory at `/app/models:ro`.
The image currently targets Linux amd64; the runtime helper fails explicitly for
unsupported architectures. The healthcheck uses `$PORT` and `/healthz`.

Railway: build and deploy settings live in the project IaC file `.railway/railway.ts`
(Dockerfile builder, this Dockerfile, watch patterns, `/healthz`, restart-on-failure with
five retries, Postgres/Redis references). Deploy with `railway up --service backend` from
the repository root.
The deployment healthcheck proves process health; `/readyz` separately proves dependencies.

Project layout, operator CLI commands and production CI setup: [deployment guide](../../docs/deploy.md).

## Inference rate limits

Scans, segmentation and receipt OCR share one inference slot, so each has a per-member limit
(per store for the daily receipt budget). A call over the limit gets `429 too_many_requests`
with a readable message and a `Retry-After` header, before any storage read or model run.
Counters live in Redis when `REDIS_URL` is set, otherwise in process memory. If the limiter
cannot be reached the call answers `503`, like the auth limits.

| Route                                       | Key              | Default | Variable                           |
| ------------------------------------------- | ---------------- | ------- | ---------------------------------- |
| `POST /v1/recognition/scans`                | store and member | 60/min  | `RATE_LIMIT_SCAN_PER_MINUTE`       |
| `POST /v1/segment` and `/v1/segment/points` | store and member | 60/min  | `RATE_LIMIT_SEGMENT_PER_MINUTE`    |
| `POST /v1/receipts` (new OCR runs only)     | store and member | 10/min  | `RATE_LIMIT_RECEIPT_PER_MINUTE`    |
| `POST /v1/receipts` (new OCR runs only)     | store            | 300/day | `RATE_LIMIT_RECEIPT_STORE_PER_DAY` |

A counter starts at the first call in its window. One scan a second is the practical ceiling
for a cashier, and a point-by-point enrollment taps a few times per product, so normal shop use
stays well below these. Idempotent replays of `POST /v1/receipts` do not spend the budget.
`POST /v1/segment` also needs a signed-in member with the enrollment permission; the mobile app
only uses `/v1/segment/points`.

## Private image storage

See the [object storage contract](../../docs/specs/object-storage.md) for every
configuration variable and response field. Postgres stores `images` metadata and
object keys; it stores neither bytes nor URLs. JPEG, PNG and WebP signatures are
detected from bytes. Images may contain up to 10 MiB, plus a bounded 64 KiB allowance
for multipart framing. Unknown fields, duplicates, missing/empty images and invalid
UUIDs return 400; unsupported signatures return 415; oversize returns 413. Upload
happens before insertion; an insertion failure triggers object deletion. Storage
failures return 502. GET returns a newly signed URL valid for 900 seconds by default.

Omit all five `AWS_*` values to disable storage (image routes return 503); a partial
or empty group fails startup. `/readyz` shows `storage: "not configured"` without
changing readiness when disabled. Configured storage is checked with `HeadBucket`;
a failure returns 503 naming `storage`. Boolean flags default to false. Enable
`S3_CREATE_BUCKET` only locally or in CI; production buckets are provisioned separately.

Compose runs RustFS 1.0.3 with a persistent named volume and a loopback-only S3 port
(default 9000). The backend uses `AWS_ENDPOINT_URL=http://storage:9000` internally.
`S3_PUBLIC_ENDPOINT_URL=http://localhost:9000` is used only for presigning so the
host-side e2e download works; it must point to the same bucket. If changing
`STORAGE_PORT`, update an explicitly configured public endpoint as well.

```sh
curl -F image=@tests/fixtures/sample.png http://localhost:8080/v1/images
curl http://localhost:8080/v1/images/<id>
# Download the returned url before url_expires_at; keep its query string intact.
```

Production credentials stay in Railway variables; follow the bucket section of the
[deployment guide](../../docs/deploy.md). No deletion API or automatic storage of
segmentation input is included.

## Seed data

**Local development only.** The seeder uses predictable credentials and fake images
and embeddings. Never run it against production or use these credentials outside a
local development database. Credentials appear on stdout only; do not redirect the
output to a file or collect it in shared logs.

From `apps/backend`, point `DATABASE_URL` at your local Postgres with pgvector:

```sh
DATABASE_URL=postgres://postgres:pw@localhost:11432/w_seed pnpm seed
# Equivalent: DATABASE_URL=... cargo run --bin taphoa-seed
```

The command runs migrations, then creates **Tạp hóa Cô Ba** and **Cửa hàng Minh Khai**.
Each store has one Lead and three sellers, a pending invite and a
used invite, eight categories, 30 branded products with pack/case units, image
metadata, normalized fake 384-dimensional embeddings, and price history. It also
creates 30 days of 15–40 sales per store/day ending on the first run's current
`Asia/Ho_Chi_Minh` business date, recognition scans/detections, manual-price and
price-mismatch reviews, voids, expenses/purchases/receipts, margin alerts, past-day
cash reconciliations, sync changes, and mostly published outbox event envelopes.
Cô Ba has sample bank details; Minh Khai has no bank profile. Both include
recorded cash and transfer sales. Image object keys are dummy
metadata: there are no corresponding storage objects.

The CLI prints store/member IDs, PIN hints, and a ready pending invite token. The
printed seller PIN is `2468`; PINs use Argon2id and invite tokens use SHA-256.

### Clerk test users

Identity lives in Clerk, so a seeded member can sign in only when `members.clerk_user_id`
names a real Clerk user. Set `CLERK_SECRET_KEY` (and `CLERK_API_URL` for a non-default
Clerk API, default `https://api.clerk.com`) before running the seed:

```sh
CLERK_SECRET_KEY=sk_test_... DATABASE_URL=... pnpm seed
```

For each seeded member the CLI finds the Clerk user with the member's email
(`GET /v1/users?email_address=`) or creates a passwordless one (`POST /v1/users`), links it
to the member and prints each member's email and role. Emails are deterministic,
`seed-<store key>-<member key>+clerk_test@example.com`, with store keys `coba` (Tạp hóa Cô
Ba) and `minhkhai` (Cửa hàng Minh Khai) and member keys `me` (Lead), `ba-noi`, `con-trai`
and `co-lan`, for example `seed-coba-me+clerk_test@example.com`. Every `+clerk_test` address
signs in with the fixed email code `424242` and sends no mail. The eval store (`--profile
eval`, epic X7) will use store key `eval` with the same scheme.

Reruns are idempotent: users that exist are reused (nothing is created twice), members of
stores that were already seeded, for example with placeholder ids, are relinked, and no
member is duplicated. The client keeps to at most four requests per second and retries
HTTP 429 after `Retry-After` (up to five times), because the development instance allows
100 requests per 10 seconds for every holder of the key. Do not delete `seed-*` users from
Clerk during cleanup sweeps; if one is deleted, the next seed run creates and relinks it.

Without `CLERK_SECRET_KEY` the seed keeps placeholder ids (`seed_<member id>`), prints one
warning that the seeded members cannot sign in, and never overwrites real ids stored by an
earlier keyed run. The key is never printed.

IDs, codes, tokens, product vectors, and the PRNG are deterministic. Each store is
seeded in one transaction, protected by a transaction-scoped advisory lock. If its
fixed fixture store ID already exists, the entire store is skipped: **same-day and
later reruns preserve every table's row counts and manual edits**, without adding
new dates or resetting credentials. The output still shows the original hints;
a consumed or expired invite is not made valid again. A
failure rolls back that store completely, and a rerun can finish the other store.
Use a fresh disposable database to regenerate a new 30-day window.

### Daily digest and push notifications

The scheduler generates one digest per active store and business date at `DIGEST_SEND_AT`
(`Asia/Ho_Chi_Minh`), pushes it through the Expo Push Service to every registered device
(`POST /v1/devices`) and reconciles push receipts about 15 minutes later. A store without a
stored digest for today gets one on demand from `GET /v1/assistant/digest`.

| Variable                   | Default                           | Purpose                                                                  |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `DIGEST_ENABLED`           | `1`                               | `0` or `false` keeps the scheduler off (local runs).                     |
| `DIGEST_SEND_AT`           | `07:00`                           | Local send time, `HH:MM`; a restart after it catches up once.            |
| `DIGEST_MODEL_MAX_PER_DAY` | `200`                             | Model-written digests per business date; beyond it the template is used. |
| `EXPO_PUSH_URL`            | `https://exp.host/--/api/v2/push` | Expo Push API base; tests point it at a mock.                            |
| `EXPO_ACCESS_TOKEN`        | unset                             | Bearer token when Expo enhanced push security is on.                     |

### Receipt OCR and confirmation

`POST /v1/receipts` reads a stored image into a draft; `GET /v1/receipts`
provides newest-first history with status/cursor filters. All receipt routes require
a Lead or `can_enroll`. Creation and confirmation require `Idempotency-Key`.

| Variable                                                                 | Default                                     | Purpose                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------- |
| `OCR_DET_PATH`, `OCR_ENCODER_PATH`, `OCR_DECODER_PATH`, `OCR_VOCAB_PATH` | unset                                       | Set all four to enable receipt OCR and the shared scan text detector. |
| `OCR_THREADS`                                                            | `4`                                         | OCR inference workers.                                                |
| `OPENROUTER_API_KEY`                                                     | empty                                       | Decisions API key; absence uses rule fallback.                        |
| `DECISIONS_MODEL`                                                        | `inception/mercury-decide`                  | Product mapping model.                                                |
| `DECISIONS_URL`                                                          | `https://openrouter.ai/api/alpha/decisions` | Decisions endpoint.                                                   |
| `DECISIONS_TIMEOUT_MS`                                                   | `2500`                                      | Decision request timeout before rule fallback.                        |

Confirm submits the full retained line set: omitted draft lines are deleted, existing
`line_id` values preserve their OCR metadata, and omitted IDs create new lines. Costs
are line totals; expense amount is their sum while purchase unit costs round up.
Zero-cost supplier items and zero-total receipts are supported; the public expense
create/patch validators still require a positive amount.
Expense, purchase costs and margin alerts, stock movements, and `receipt.confirmed`
share one transaction. ImageRepository has no update-purpose port, so receipt photos
retain their existing image purpose. Presigned URLs are generated on read.

Scan text detection overlaps segmentation and can add at most 50 ms of waiting after
inference. A detector failure or timeout returns the default absent signal. Blocking
work retains the inference admission permit until both jobs complete, including
after request cancellation. The signal is retained in the scan timing snapshot for GET.
