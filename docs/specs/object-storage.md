# Object storage for images

Status: Accepted · Date: 2026-10-23 · Related: [monorepo setup](monorepo-setup.md), [ADR 0002](../adr/0002-object-storage.md)

## Goal

Store product and checkout photos in S3-compatible object storage. Postgres keeps
only a reference row per image (id + object key + small metadata), never image bytes.
This prepares PRD §9 "Data collection (phase 1)": every enrollment and checkout photo
is kept for phase 2 training.

## Decisions

| Area                | Decision                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production storage  | Railway Bucket `images` (S3-compatible, private), region `sin` (closest to Vietnam). Declared in `.railway/railway.ts`.                                                                                                                                           |
| Local / CI storage  | RustFS container (`rustfs/rustfs:1.0.3`, pinned release tag) in `docker-compose.yml`. MinIO is not used: its repository is archived.                                                                                                                              |
| Rust client         | `aws-sdk-s3` with `aws-config`; custom endpoint; path-style flag; presigned GET URLs.                                                                                                                                                                             |
| What Postgres keeps | `images` row: `id`, `store_id` (nullable FK), `object_key`, `content_type`, `byte_size`, `purpose`, `created_at`. The object key is the stable pointer. URLs are not stored, because the bucket is private and presigned URLs expire; the API signs one per read. |
| Object key format   | `images/{yyyy}/{mm}/{uuid}.{ext}`, where `uuid` is the row id.                                                                                                                                                                                                    |

## Configuration (environment)

Names follow Railway's bucket credential variables.

| Variable                 | Meaning                                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_ENDPOINT_URL`       | S3 endpoint (Railway bucket endpoint, or `http://storage:9000` locally)                                                                                                    |
| `AWS_ACCESS_KEY_ID`      | Access key                                                                                                                                                                 |
| `AWS_SECRET_ACCESS_KEY`  | Secret key                                                                                                                                                                 |
| `AWS_S3_BUCKET_NAME`     | Bucket name                                                                                                                                                                |
| `AWS_DEFAULT_REGION`     | Region string passed to the SDK                                                                                                                                            |
| `S3_PUBLIC_ENDPOINT_URL` | Optional endpoint used only for presigning; defaults to `AWS_ENDPOINT_URL`. Compose uses `http://localhost:9000` so host clients can download. Must reach the same bucket. |
| `S3_FORCE_PATH_STYLE`    | `true` locally; Railway value follows its `urlStyle` credential field                                                                                                      |
| `S3_CREATE_BUCKET`       | `true` only for local/CI: create the bucket at startup if missing                                                                                                          |
| `IMAGE_URL_TTL_SECONDS`  | Presigned GET lifetime, default 900                                                                                                                                        |

Storage is optional at startup like the SAM model: when the `AWS_*` set is absent, image
routes return 503 and `/readyz` reports storage as not configured. A partially set
`AWS_*` group is a startup error (all five values must be nonempty).
When storage is absent, readiness is unaffected and JSON includes
`"storage":"not configured"`. When configured, `HeadBucket` failure returns 503
with `storage` in `dependencies` and `"storage":"unavailable"`; success reports
`"storage":"ok"`. `S3_FORCE_PATH_STYLE` and `S3_CREATE_BUCKET` default to false.
`IMAGE_URL_TTL_SECONDS` must be 1–604800 seconds (S3 maximum).

The image limit counts image bytes, with an additional 64 KiB maximum allowance
for multipart framing. Empty, duplicate or unexpected fields are bad input. An
unknown `store_id` returns 400 and deletes the uploaded object. Reference database
failures return 500 and attempt the same cleanup. URL expiry is an RFC 3339 UTC
timestamp. MIME type and extension come from the signature, not the filename or
caller-supplied MIME header.

## API

| Route                 | Behavior                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/images`     | multipart: `image` (required), `store_id` (optional uuid), `purpose` (optional: `enrollment`, `checkout`, `expense_receipt`, `other`; default `other`; unknown value is 400). Accept JPEG, PNG, WebP detected from magic bytes; max 10 MiB. Upload object, then insert row. If the insert fails, delete the object. 201 `{id, object_key, content_type, byte_size, purpose, url, url_expires_at}`. |
| `GET /v1/images/{id}` | 200 same shape with a fresh presigned URL; 404 when unknown.                                                                                                                                                                                                                                                                                                                                       |
| `GET /readyz`         | Also checks storage with `HeadBucket` when configured.                                                                                                                                                                                                                                                                                                                                             |

Errors: 400 bad multipart / missing field / bad uuid, 413 too large, 415 unsupported type,
503 storage not configured, 502 storage failure.

## Tests

- Unit: storage behind an `ObjectStore` trait with an in-memory fake; handler tests for
  201/404/413/415/503 and the delete-on-insert-failure path.
- Integration: real Postgres + RustFS: upload, row exists, presigned URL downloads identical bytes.
- e2e: `packages/e2e/tests/health.test.ts` uploads an image, gets its presigned URL, downloads
  it, and checks status 200, an `image/*` content type, and identical bytes. This passed on
  Railway `test` in [run 40726908085](https://github.com/datamonsterr/taphoa-mini/actions/runs/40726908085).
- Compose e2e (`scripts/e2e.sh`): upload, get, download through the presigned URL.

## Out of scope

- Mobile upload UI. Linking images to products or sales. Thumbnails, resizing, lifecycle
  rules, deletion API. Persisting `/v1/segment` input photos (next step).

## Local endpoints

RustFS listens on S3 port 9000. Compose binds `${STORAGE_PORT:-9000}` to
127.0.0.1 and persists objects in `storage_data`; its healthcheck uses `/health`.
The backend sends objects to `http://storage:9000` and signs URLs using
`S3_PUBLIC_ENDPOINT_URL` (default `http://localhost:${STORAGE_PORT:-9000}`).
If you change the host port in `.env`, update an explicitly set public endpoint too.
For physical devices, choose a reachable endpoint and an appropriate network
exposure explicitly. Host integration tests use `AWS_ENDPOINT_URL=http://localhost:9000`.

Verified against [RustFS 1.0.3](https://github.com/rustfs/rustfs/releases/tag/1.0.3)
and its [Docker installation guide](https://docs.rustfs.com/en/installation/container/docker).
The client uses the [aws-sdk-s3 presigning API](https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/operation/get_object/builders/struct.GetObjectFluentBuilder.html#method.presigned).
