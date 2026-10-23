# Monorepo setup spec

Status: Accepted · Date: 2026-10-23 · Source: [PRD](../PRD.md) §9, §10

## Goal

Turn the repository into a monorepo with a running skeleton of every part of the
Tạp Hóa Mini stack: Expo mobile app, Rust recognition/API server, Postgres,
Redis, Docker, Railway config-as-code, and a CI/CD pipeline with local git hooks.
No product features yet. Every layer must build, test and run.

## Decisions

| Area                 | Decision                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS package manager   | pnpm workspaces (pnpm 11, Node from `.nvmrc`)                                                                                                                                                                   |
| Task runner          | Turborepo at the root (`turbo.json`)                                                                                                                                                                            |
| Mobile               | Expo (latest SDK from `create-expo-app@latest`), TypeScript, Expo Router. EAS project id `aacb6d3c-093a-4da0-ae2c-fbc9ce53a458`                                                                                 |
| Mobile tests         | `jest-expo` + `@testing-library/react-native` (unit); Maestro flows (e2e) run by an EAS Workflow                                                                                                                |
| Mobile lint/format   | `expo lint` (ESLint flat config) + Prettier; `tsc --noEmit`                                                                                                                                                     |
| Backend              | Rust stable (`rust-toolchain.toml`), Cargo workspace in `apps/backend`, axum + tokio                                                                                                                            |
| Recognition, phase 1 | SAM ONNX encoder/decoder run through the `ort` crate, following https://github.com/AndreyGermanov/sam_onnx_rust. Behind a `Segmenter` trait. YOLO ONNX adapter is a stub implementing the same trait (phase 2). |
| Model weights        | Never committed. `apps/backend/scripts/fetch-models.sh` downloads them into `apps/backend/models/` (gitignored). The Docker image downloads them at build time.                                                 |
| Database             | Postgres 17 with pgvector (`pgvector/pgvector:pg17` locally). `sqlx` with migrations in `apps/backend/migrations`.                                                                                              |
| Cache                | Redis 7. Rust client via `redis` crate (tokio + connection manager) or `deadpool-redis`.                                                                                                                        |
| Containers           | Multi-stage Dockerfile for backend (cargo-chef caching, slim runtime). Dev Dockerfile for mobile that runs the Expo dev server. Root `docker-compose.yml`.                                                      |
| Hosting              | Railway. Config-as-code with `railway.json` per deployed service. Railway services: `backend`, Postgres, Redis. Mobile is not hosted on Railway; native builds go through EAS.                                  |
| CI                   | GitHub Actions. Deploy to Railway from `main` with `RAILWAY_TOKEN`. EAS Workflows for mobile build and Maestro e2e.                                                                                             |
| Git hooks            | lefthook: `pre-commit` format check on staged files, `commit-msg` Conventional Commits (commitlint), `pre-push` lint + typecheck + unit tests.                                                                  |

## Layout

```
.
├── apps/
│   ├── mobile/            # Expo app (pnpm workspace package "@taphoa/mobile")
│   │   ├── .maestro/      # Maestro e2e flows
│   │   ├── .eas/workflows/
│   │   └── Dockerfile.dev
│   └── backend/           # Cargo workspace
│       ├── crates/api/          # axum binary "taphoa-api"
│       ├── crates/recognition/  # Segmenter trait, SAM (ort), YOLO stub
│       ├── migrations/
│       ├── scripts/fetch-models.sh
│       ├── Dockerfile
│       └── railway.json
├── docs/ (PRD, specs, adr)
├── docker-compose.yml
├── lefthook.yml
├── package.json  pnpm-workspace.yaml  turbo.json
├── rust-toolchain.toml  .nvmrc  .editorconfig  .gitignore
└── .github/workflows/
```

## Backend API (skeleton)

| Route              | Behavior                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`     | 200 `{"status":"ok"}`. No dependencies.                                                                                                      |
| `GET /readyz`      | 200 when Postgres (`SELECT 1`) and Redis (`PING`) answer, else 503 with the failing dependency named.                                        |
| `POST /v1/segment` | multipart `image` field. Runs the configured `Segmenter`. Returns JSON list of `{bbox:[x,y,w,h], score, area}`. 503 when no model is loaded. |

Configuration from environment only: `PORT` (default 8080), `DATABASE_URL`, `REDIS_URL`,
`SAM_ENCODER_PATH`, `SAM_DECODER_PATH`, `RUST_LOG`. Structured logs with `tracing`.
Graceful shutdown on SIGTERM. Migrations run at startup.

## Test levels

| Level       | Mobile                                   | Backend                                                                                                                                 |
| ----------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | jest-expo                                | `cargo test` with a mock `Segmenter`                                                                                                    |
| Integration | —                                        | `cargo test -- --ignored` or feature-gated tests against real Postgres + Redis (`DATABASE_URL`, `REDIS_URL` set; CI service containers) |
| Model       | —                                        | SAM inference test, skipped when model files are absent                                                                                 |
| e2e         | Maestro smoke flow via EAS Workflow      | `docker compose up` then HTTP smoke script against `/healthz`, `/readyz`, `/v1/segment`                                                 |
| Build       | `expo export` (CI), EAS build (workflow) | `cargo build --release`, `docker build`                                                                                                 |

## Root commands

`pnpm install`, `pnpm lint`, `pnpm format`, `pnpm format:check`, `pnpm typecheck`,
`pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm build`. Each runs both
apps through Turborepo; the backend is wrapped as a workspace package
(`apps/backend/package.json` with scripts calling cargo) so one runner drives both.

## Out of scope

- Product features (catalog, checkout, VietQR, reports, sync).
- Embedding model and vector search (only the pgvector extension is enabled).
- Automatic SAM "segment everything" quality tuning; a coarse point-grid is enough.
- App store submission.
