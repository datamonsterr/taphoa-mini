# ADR 0002: Object storage for images

Status: Accepted · Date: 2026-10-23

## Context

The app captures enrollment and checkout photos. PRD §9 requires keeping them as
labeled data for phase 2 YOLO training. Image bytes in Postgres would bloat backups
and the database volume. Railway now offers S3-compatible Buckets inside the project.

## Decision

- Store image bytes in a private Railway Bucket (`images`, region `sin`), declared in
  `.railway/railway.ts`.
- Postgres stores one `images` row per object: id, nullable `store_id`, `object_key`,
  `content_type`, `byte_size`, `created_at`. It stores the key, not a URL.
- The API returns presigned GET URLs with a short lifetime (default 15 min).
- The backend uses `aws-sdk-s3` against any S3 endpoint. Local development and CI use a
  RustFS container. MinIO is not used because its repository is archived.

## Consequences

- Clients never get bucket credentials; access is through the API.
- The bucket region (`sin`) differs from the current Railway service region (`sfo`).
  Uploads cross the Pacific once; downloads go straight from Singapore to phones in
  Vietnam. Moving services to an Asian region is a later decision.
- Bucket credentials are not referencable from IaC. They are set once as backend
  variables (`railway bucket credentials` then `railway variable set`) and kept with
  `preserve()` in `.railway/railway.ts`.
- Upload then insert is not atomic. On insert failure the object is deleted; a crash in
  between can leave an orphan object, which a later cleanup job can remove.
