# Project vocabulary

Product terms follow [PRD §13](docs/PRD.md#13-glossary). Planned product behavior is
separate from the current infrastructure skeleton.

| Term                          | Meaning                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Tạp hóa                       | Small neighborhood convenience/grocery store.                                                                                       |
| Hộ kinh doanh                 | Household business, the legal form of most tạp hóa.                                                                                 |
| Thuế khoán                    | Presumptive lump-sum tax described in the PRD as being phased out.                                                                  |
| VietQR                        | NAPAS interbank QR standard; planned checkout payment QR with an exact amount.                                                      |
| Enrollment                    | Adding a product to the catalog by photo and price.                                                                                 |
| Lead                          | Family member who owns prices; a planned application role.                                                                          |
| Chốt sổ                       | End-of-day close and cash reconciliation.                                                                                           |
| Segmenter                     | Rust trait abstracting image segmentation; API code depends on this interface.                                                      |
| SAM                           | Segment Anything Model; phase-one ONNX encoder/decoder segmentation adapter.                                                        |
| ONNX / ort                    | Portable model format / Rust bindings for ONNX Runtime. Weights and runtime are separate downloads.                                 |
| YOLO                          | Phase-two detection adapter; currently an unimplemented Segmenter stub.                                                             |
| Bounding box                  | Segment rectangle `[x, y, width, height]`, accompanied by score and pixel area.                                                     |
| pgvector                      | Postgres extension for vector operations; enabled by migration, without product embedding/search features yet.                      |
| axum / tokio                  | Rust HTTP framework / asynchronous runtime.                                                                                         |
| SQLx                          | Rust SQL client and migration tooling.                                                                                              |
| Redis                         | Cache/dependency service checked by API readiness.                                                                                  |
| Health / readiness            | `/healthz` proves the process responds; `/readyz` additionally checks Postgres, Redis and configured object storage.                |
| Expo SDK / Expo Router        | Mobile runtime/tooling release / file-based React Native routing.                                                                   |
| EAS Workflow                  | Expo-hosted YAML automation for native builds and Maestro tests. Config lives under the mobile app.                                 |
| Maestro                       | Mobile UI smoke-test runner operating on an installed app/device.                                                                   |
| pnpm workspace / Turborepo    | Package/dependency organization / root task runner across mobile and backend wrappers.                                              |
| cargo-chef                    | Docker dependency planning and compilation stages retained as reusable build layers.                                                |
| Compose profile               | Optional group of local services; `mobile` adds the Expo development server.                                                        |
| Railway service / environment | Deployable app or database / isolated project configuration such as production.                                                     |
| Railway IaC                   | Railway project graph (services, databases, volumes, variables) tracked in `.railway/railway.ts`.                                   |
| Model-free image              | `SKIP_MODELS=1`: ONNX Runtime is included, SAM weights are absent, segmentation deliberately returns 503.                           |
| Conventional Commits          | Structured Git messages such as `fix: repair readiness check`, enforced by commitlint.                                              |
| Object key                    | Stable private-bucket path such as `images/2026/10/<uuid>.png`; persisted in Postgres instead of bytes or a URL.                    |
| Presigned URL                 | Time-limited signed GET URL for a private image; generated on each API read and never stored.                                       |
| Railway Bucket                | Private S3-compatible object storage; the `images` bucket holds photo bytes while Postgres holds references.                        |
| Scan                          | Proposed: one recognition request on a photo; stores the photo, detections and candidates. See `docs/architecture.md`.              |
| Detection                     | Proposed: one segmented crop in a scan, with top-k product candidates and a match class.                                            |
| Manual line                   | Proposed: sale line sold without a catalog match (or at a mismatched price); queued for Lead review.                                |
| Outbox                        | Proposed: phone queue of pending writes replayed idempotently; server-side `outbox_events` table for events.                        |
| Change feed                   | Proposed: `GET /v1/sync/changes`, cursor-ordered upserts/deletes of server-owned entities for the phone replica.                    |
| Business date                 | Proposed: calendar date in `Asia/Ho_Chi_Minh` stored on sales/expenses; reports and chốt sổ group by it.                            |
| Session (app)                 | Access + refresh token, member and store kept by the app in `expo-secure-store` (web: `localStorage`); no session means onboarding. |
| Recovery code                 | One-time code shown after store creation or recovery; the app stays on onboarding until the Lead confirms saving it.                |
| Quick enroll                  | Proposed: tag-toggle camera mode; 3..8 photos, each cut out by MobileSAM from 1-2 tapped points. See `docs/specs/quick-enroll.md`.  |
| Point prompt                  | Proposed: 1-2 tapped pixels (foreground/background label) sent to `POST /v1/segment/points`.                                        |
| Cutout                        | Proposed: masked product crop on a neutral grey background, stored as an image and embedded as a reference.                         |
| Prototype                     | Proposed: per-product mean of its reference embeddings; few-shot score is `max(best reference, prototype)`.                         |
| Index job                     | Proposed: background job that embeds references, recomputes the prototype and emits `product.indexed`.                              |
| Test double (mobile)          | `apps/mobile/src/test/mock`, an in-memory fake of the API for Jest only; the app bundle never imports it.                           |
