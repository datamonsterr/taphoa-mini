# Object storage for images

Status: Accepted · Date: 2026-10-23 · Related: [monorepo setup](monorepo-setup.md), [ADR 0002](../adr/0002-object-storage.md)

## Goal

Store product and checkout photos in S3-compatible object storage. Postgres keeps
only a reference row per image (id + object key + small metadata), never image bytes.
This prepares PRD §9 "Data collection (phase 1)": every enrollment and checkout photo
is kept for phase 2 training.

## Decisions

| Area                | Decision                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production storage  | Railway Bucket `images` (S3-compatible, private), region `sin` (closest to Vietnam). Declared in `.railway/railway.ts`.                                                                                                                                |
| Local / CI storage  | RustFS container (`rustfs/rustfs`, pinned tag) in `docker-compose.yml`. MinIO is not used: its repository is archived.                                                                                                                                 |
| Rust client         | `aws-sdk-s3` with `aws-config`; custom endpoint; path-style flag; presigned GET URLs.                                                                                                                                                                  |
| What Postgres keeps | `images` row: `id`, `store_id` (nullable FK), `object_key`, `content_type`, `byte_size`, `created_at`. The object key is the stable pointer. URLs are not stored, because the bucket is private and presigned URLs expire; the API signs one per read. |
| Object key format   | `images/{yyyy}/{mm}/{uuid}.{ext}`, where `uuid` is the row id.                                                                                                                                                                                         |

## Configuration (environment)

Names follow Railway's bucket credential variables.

| Variable                | Meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `AWS_ENDPOINT_URL`      | S3 endpoint (Railway bucket endpoint, or `http://storage:9000` locally) |
| `AWS_ACCESS_KEY_ID`     | Access key                                                              |
| `AWS_SECRET_ACCESS_KEY` | Secret key                                                              |
| `AWS_S3_BUCKET_NAME`    | Bucket name                                                             |
| `AWS_DEFAULT_REGION`    | Region string passed to the SDK                                         |
| `S3_FORCE_PATH_STYLE`   | `true` locally; Railway value follows its `urlStyle` credential field   |
| `S3_CREATE_BUCKET`      | `true` only for local/CI: create the bucket at startup if missing       |
| `IMAGE_URL_TTL_SECONDS` | Presigned GET lifetime, default 900                                     |

Storage is optional at startup like the SAM model: when the `AWS_*` set is absent, image
routes return 503 and `/readyz` reports storage as not configured. A partially set
`AWS_*` group is a startup error.

## API

| Route                 | Behavior                                                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/images`     | multipart: `image` (required), `store_id` (optional uuid). Accept JPEG, PNG, WebP detected from magic bytes; max 10 MiB. Upload object, then insert row. If the insert fails, delete the object. 201 `{id, object_key, content_type, byte_size, url, url_expires_at}`. |
| `GET /v1/images/{id}` | 200 same shape with a fresh presigned URL; 404 when unknown.                                                                                                                                                                                                           |
| `GET /readyz`         | Also checks storage with `HeadBucket` when configured.                                                                                                                                                                                                                 |

Errors: 400 bad multipart / missing field / bad uuid, 413 too large, 415 unsupported type,
503 storage not configured, 502 storage failure.

## Tests

- Unit: storage behind an `ObjectStore` trait with an in-memory fake; handler tests for
  201/404/413/415/503 and the delete-on-insert-failure path.
- Integration: real Postgres + RustFS: upload, row exists, presigned URL downloads identical bytes.
- e2e (`scripts/e2e.sh` against Compose): upload, get, download through the presigned URL.

## Out of scope

- Mobile upload UI. Linking images to products or sales. Thumbnails, resizing, lifecycle
  rules, deletion API. Persisting `/v1/segment` input photos (next step).
