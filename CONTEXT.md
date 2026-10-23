# Project vocabulary

Product terms follow [PRD §13](docs/PRD.md#13-glossary). Planned product behavior is
separate from the current infrastructure skeleton.

| Term                          | Meaning                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Tạp hóa                       | Small neighborhood convenience/grocery store.                                                                  |
| Hộ kinh doanh                 | Household business, the legal form of most tạp hóa.                                                            |
| Thuế khoán                    | Presumptive lump-sum tax described in the PRD as being phased out.                                             |
| VietQR                        | NAPAS interbank QR standard; planned checkout payment QR with an exact amount.                                 |
| Enrollment                    | Adding a product to the catalog by photo and price.                                                            |
| Lead                          | Family member who owns prices; a planned application role.                                                     |
| Chốt sổ                       | End-of-day close and cash reconciliation.                                                                      |
| Segmenter                     | Rust trait abstracting image segmentation; API code depends on this interface.                                 |
| SAM                           | Segment Anything Model; phase-one ONNX encoder/decoder segmentation adapter.                                   |
| ONNX / ort                    | Portable model format / Rust bindings for ONNX Runtime. Weights and runtime are separate downloads.            |
| YOLO                          | Phase-two detection adapter; currently an unimplemented Segmenter stub.                                        |
| Bounding box                  | Segment rectangle `[x, y, width, height]`, accompanied by score and pixel area.                                |
| pgvector                      | Postgres extension for vector operations; enabled by migration, without product embedding/search features yet. |
| axum / tokio                  | Rust HTTP framework / asynchronous runtime.                                                                    |
| SQLx                          | Rust SQL client and migration tooling.                                                                         |
| Redis                         | Cache/dependency service checked by API readiness.                                                             |
| Health / readiness            | `/healthz` proves the process responds; `/readyz` additionally checks Postgres and Redis.                      |
| Expo SDK / Expo Router        | Mobile runtime/tooling release / file-based React Native routing.                                              |
| EAS Workflow                  | Expo-hosted YAML automation for native builds and Maestro tests. Config lives under the mobile app.            |
| Maestro                       | Mobile UI smoke-test runner operating on an installed app/device.                                              |
| pnpm workspace / Turborepo    | Package/dependency organization / root task runner across mobile and backend wrappers.                         |
| cargo-chef                    | Docker dependency planning and compilation stages retained as reusable build layers.                           |
| Compose profile               | Optional group of local services; `mobile` adds the Expo development server.                                   |
| Railway service / environment | Deployable app or database / isolated project configuration such as production.                                |
| Railway IaC                   | Railway project graph (services, databases, volumes, variables) tracked in `.railway/railway.ts`.              |
| Model-free image              | `SKIP_MODELS=1`: ONNX Runtime is included, SAM weights are absent, segmentation deliberately returns 503.      |
| Conventional Commits          | Structured Git messages such as `fix: repair readiness check`, enforced by commitlint.                         |
