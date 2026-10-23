# ADR 0001: Monorepo stack

Status: Accepted · Date: 2026-10-23

## Context

The [PRD](../PRD.md) calls for a phone-first Vietnamese family-store POS with
photo enrollment and eventual multi-item recognition. The [setup spec](../specs/monorepo-setup.md)
requires a runnable, testable skeleton before product features. One repository
must support mobile, inference, persistence, local development, and delivery.

## Decisions

The accepted spec's decisions are reproduced below. The generated mobile app is
currently Expo SDK 58; Node is 24 and pnpm is pinned to 11.5.0.

| Area                 | Decision                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JS package manager   | pnpm workspaces (pnpm 11, Node from `.nvmrc`)                                                                                                                                                                                                          |
| Task runner          | Turborepo at the root (`turbo.json`)                                                                                                                                                                                                                   |
| Mobile               | Expo (latest SDK from `create-expo-app@latest`), TypeScript, Expo Router. EAS project id `aacb6d3c-093a-4da0-ae2c-fbc9ce53a458`                                                                                                                        |
| Mobile tests         | `jest-expo` + `@testing-library/react-native` (unit); Maestro flows (e2e) run by an EAS Workflow                                                                                                                                                       |
| Mobile lint/format   | `expo lint` (ESLint flat config) + Prettier; `tsc --noEmit`                                                                                                                                                                                            |
| Backend              | Rust stable (`rust-toolchain.toml`), Cargo workspace in `apps/backend`, axum + tokio                                                                                                                                                                   |
| Recognition, phase 1 | SAM ONNX encoder/decoder run through the `ort` crate, following https://github.com/AndreyGermanov/sam_onnx_rust. Behind a `Segmenter` trait. YOLO ONNX adapter is a stub implementing the same trait (phase 2).                                        |
| Model weights        | Never committed. `apps/backend/scripts/fetch-models.sh` downloads them into `apps/backend/models/` (gitignored). The Docker image downloads them at build time.                                                                                        |
| Database             | Postgres 18 with pgvector (`pgvector/pgvector:0.8.7-pg18-trixie` locally, in CI and on Railway). `sqlx` with migrations in `apps/backend/migrations`.                                                                                                  |
| Cache                | Redis 7. Rust client via `redis` crate (tokio + connection manager) or `deadpool-redis`.                                                                                                                                                               |
| Containers           | Multi-stage Dockerfile for backend (cargo-chef caching, slim runtime). Dev Dockerfile for mobile that runs the Expo dev server. Root `docker-compose.yml`.                                                                                             |
| Hosting              | Railway. Infrastructure as Code in `.railway/railway.ts` (`railway config plan/apply`); legacy `railway.json` is deprecated and not used. Railway services: `backend`, Postgres, Redis. Mobile is not hosted on Railway; native builds go through EAS. |
| CI                   | GitHub Actions. Deploy to Railway from `main` with `RAILWAY_TOKEN`. EAS Workflows for mobile build and Maestro e2e.                                                                                                                                    |
| Git hooks            | lefthook: `pre-commit` format check on staged files, `commit-msg` Conventional Commits (commitlint), `pre-push` lint + typecheck + unit tests.                                                                                                         |

## Rationale

- pnpm workspaces centralize dependency resolution. Turborepo provides consistent
  root commands; a small backend package wrapper delegates to Cargo without
  replacing Rust's workspace tooling.
- Expo and Router support a TypeScript mobile skeleton and EAS native delivery.
  Jest covers fast component tests; Maestro exercises the installed app through
  EAS Workflows without putting native emulators into the default local stack.
- Rust stable, axum and tokio provide a shared asynchronous API and recognition
  implementation. A Segmenter trait keeps SAM replaceable by the future YOLO
  adapter and permits deterministic API tests with mocks.
- ONNX Runtime is loaded dynamically through ort. The checksum-verified runtime
  helper and uncommitted, pinned SAM downloads make heavyweight assets explicit.
  Model-free CI checks service wiring without claiming inference quality.
- Postgres 17 plus pgvector preserves the future vector-search path while SQLx
  migrations keep schema evolution explicit. Redis is a separate dependency;
  readiness checks both services independently.
- Multi-stage Docker keeps compilers out of the runtime and cargo-chef caches
  dependencies as ordinary layers. Cache mounts are omitted because Railway
  requires service-specific IDs; the same Dockerfile builds locally and remotely.
  Repository-root context preserves the documented monorepo build contract.
- Compose gives healthy dependency ordering and persistent local Postgres. The
  mobile profile remains optional so default startup only needs the backend stack.
- Railway hosts backend/Postgres/Redis; EAS owns mobile builds. Per-service JSON
  makes build paths and healthchecks reviewable. GitHub deploys only a tested main
  revision using a project-scoped token.
- lefthook and commitlint enforce quick staged formatting, consistent messages,
  and pre-push checks. Separate GitHub jobs provide fresh mobile, Rust,
  real-service, and container validation.

## Consequences

Developers need Node/pnpm and Rust locally; Docker is needed for service tests.
Native mobile e2e additionally needs an APK/device or authorized EAS setup. Model
weights consume substantial disk and remain opt-in locally. Health is distinct
from dependency readiness, and model-free 503 smoke evidence does not prove SAM
inference. Catalog, payment, sync, embeddings, and search remain outside this ADR's
implementation scope.
