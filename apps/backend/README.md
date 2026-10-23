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

Use Postgres 17 with pgvector and Redis 7. `DATABASE_URL` and `REDIS_URL` configure
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

| Endpoint           | Result                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `GET /healthz`     | 200 `{"status":"ok"}`, without dependency checks                                                   |
| `GET /readyz`      | 200 after `SELECT 1` and Redis `PING`; otherwise 503 with `dependencies` naming `postgres`/`redis` |
| `POST /v1/segment` | multipart field `image`; JSON array of `{bbox:[x,y,w,h],score,area}`; 503 without a model          |

```sh
curl -F image=@tests/fixtures/sample.png http://localhost:8080/v1/segment
```

Uploads are limited to 10 MiB including multipart framing. SAM decodes PNG/JPEG
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
# Explicitly run the ignored integration test; absent URLs print a skip message.
DATABASE_URL=postgres://taphoa:taphoa@localhost:5432/taphoa \
REDIS_URL=redis://localhost:6379 cargo test -p taphoa-api --test readiness -- --ignored --nocapture
# Runs encoder + all 64 decoder prompts when model files exist; prints SKIP otherwise.
cargo test -p taphoa-recognition --test model -- --nocapture
BASE_URL=http://localhost:8080 ./scripts/e2e.sh
```

`package.json` exposes `lint`, `format`, `format:check`, `typecheck`, `test`,
`test:integration`, `test:e2e`, and `build` for root Turborepo commands. The HTTP smoke
script expects 200 on all three routes by default; set `EXPECT_SEGMENT_STATUS=503` (legacy `SEGMENT_EXPECTED_STATUS` also works)
only when intentionally testing a model-free image. Missing readiness fails the smoke.

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
