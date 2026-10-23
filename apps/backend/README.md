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
set, or both files absent, segmentation returns 503. One missing file, invalid model,
or missing runtime with existing models fails startup. `RUST_LOG` controls tracing;
`LOG_FORMAT=json` enables JSON logs and is the Docker default. SIGTERM/Ctrl-C drains
requests and closes the Postgres pool. Configuration is environment-only; the binary
does not automatically read `.env`.

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

Model downloads come from the [Image Arjun Raj Laboratory SAM vit_b export](https://huggingface.co/rajlab/sam_vit_b),
revision `c20401a6d978ab52ba87b5e05909be65c79b0686` (Apache-2.0). The fetch script
checks pinned SHA-256 hashes before an atomic rename, prints checksums, and reuses
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
Each store has one Lead and three sellers, device sessions, a pending invite and a
used invite, eight categories, 30 branded products with pack/case units, image
metadata, normalized fake 384-dimensional embeddings, and price history. It also
creates 30 days of 15–40 sales per store/day ending on the first run's current
`Asia/Ho_Chi_Minh` business date, recognition scans/detections, manual-price and
price-mismatch reviews, voids, expenses/purchases/receipts, margin alerts, past-day
cash reconciliations, sync changes, and mostly published outbox event envelopes.
Cô Ba has sample bank details; Minh Khai has no bank profile. Both include
recorded cash and transfer sales. Image object keys are dummy
metadata: there are no corresponding storage objects.

The CLI prints store/member IDs, the original deterministic recovery codes, PIN
hints, and a ready pending invite token. Use the printed recovery code to sign in
as the Lead through `POST /v1/auth/recover`:

```sh
curl -X POST http://localhost:8080/v1/auth/recover \
  -H 'Content-Type: application/json' \
  -d '{"recovery_code":"REPLACE-WITH-PRINTED-CODE","device":{"name":"Local browser","platform":"web","app_version":"1.0.0"}}'
```

Recovery rotates the code: save the new code returned by the endpoint. The printed
code is normalized to uppercase with hyphens/spaces removed for authentication;
only its Argon2id hash and SHA-256 lookup digest are stored. PINs use Argon2id;
invite tokens use SHA-256. The printed seller PIN is `2468`.

IDs, codes, tokens, product vectors, and the PRNG are deterministic. Each store is
seeded in one transaction, protected by a transaction-scoped advisory lock. If its
fixed fixture store ID already exists, the entire store is skipped: **same-day and
later reruns preserve every table's row counts and manual edits**, without adding
new dates or resetting credentials. The output still shows the original hints;
a consumed/expired invite or rotated recovery code is not made valid again. A
failure rolls back that store completely, and a rerun can finish the other store.
Use a fresh disposable database to regenerate a new 30-day window.
