# Tạp Hóa Mini

Tạp Hóa Mini is a phone-first point-of-sale app for small family-run convenience stores in Vietnam. A shopkeeper photographs items on the counter; the planned app recognizes products, shows the total, displays a VietQR payment code, and records sales for end-of-day reconciliation. This repository currently contains the mobile/API infrastructure skeleton, including SAM segmentation; catalog, checkout, payments, and reports are future work. See the [PRD](docs/PRD.md) and [accepted setup spec](docs/specs/monorepo-setup.md).

## Layout

```text
apps/mobile/              Expo SDK 58, TypeScript, Expo Router
  .eas/workflows/          Native Android builds and Maestro smoke tests
apps/backend/             Rust workspace: axum API and recognition crates
  migrations/             SQLx migrations, including pgvector
  scripts/                Model/runtime downloads and HTTP smoke test
docs/                     PRD, specs, deployment guide, architecture decisions
docker-compose.yml        Local Postgres, Redis, API; optional mobile profile
.github/workflows/        CI and production backend deployment
```

App details: [backend](apps/backend/README.md), [mobile](apps/mobile/README.md).
Terminology: [CONTEXT.md](CONTEXT.md). Decisions: [ADR 0001](docs/adr/0001-monorepo-stack.md).

## Prerequisites

- Node **24** (`.nvmrc`) and pnpm **11.5.0** (`packageManager`).
- Rust stable with rustfmt and clippy (`rust-toolchain.toml`).
- Docker Engine with Compose v2 and BuildKit.
- An Android emulator or Expo-compatible device; Maestro is optional for local mobile e2e.
- For local SAM inference: compatible ONNX Runtime (Linux amd64 helper provided) and downloaded model weights. Docker includes the runtime.

## Quickstart

From the repository root:

```sh
pnpm install
cp .env.example .env
cp apps/mobile/.env.example apps/mobile/.env
# Start only Postgres, Redis and the backend. First run builds the API image.
docker compose up -d --wait
curl http://localhost:8080/readyz
pnpm --filter @taphoa/mobile start
```

The default image skips model weights (`SKIP_MODELS=1`), so segmentation returns **503**.
To enable SAM without rebuilding the image, download the weights and opt into the read-only bind mount:

```sh
apps/backend/scripts/fetch-models.sh
docker compose -f docker-compose.yml -f docker-compose.models.yml up -d --wait
```

Weights are large and gitignored. Alternatively set `SKIP_MODELS=0` and run
`docker compose build backend` to include them in an image. Backend Docker builds
always need the **repository root** context: `docker build -f apps/backend/Dockerfile .`.
A host-side Rust process additionally needs `apps/backend/scripts/fetch-onnxruntime.sh`
and the printed `ORT_DYLIB_PATH`; see the backend README.

Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to an address reachable from the device:
`http://10.0.2.2:8080` for the Android emulator, or your host LAN IP for a phone.
Expo public variables are bundled into the app and must contain no secrets.
For the optional containerized Expo server, set the LAN IP in root `.env` as well
(`EXPO_PUBLIC_API_URL` and `REACT_NATIVE_PACKAGER_HOSTNAME`), then run:

```sh
docker compose --profile mobile up -d --wait
```

Postgres and Redis publish to loopback ports **55432** and **56379** by default.
The API publishes **8080**; change `BACKEND_PORT` if occupied and update mobile/smoke URLs.
Compose uses service DNS names internally. Root `.env` configures Compose; pnpm/Cargo
do not automatically load it. Export the host URLs explicitly for integration tests:

```sh
DATABASE_URL=postgres://taphoa:taphoa@localhost:55432/taphoa \
REDIS_URL=redis://localhost:56379 pnpm --filter @taphoa/backend test:integration
EXPECT_SEGMENT_STATUS=503 pnpm --filter @taphoa/backend test:e2e
# When models are mounted, omit EXPECT_SEGMENT_STATUS to require real inference.
docker compose down
# Also erase this stack's database when finished with disposable tests:
docker compose down -v
```

## Root commands

| Command                 | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `pnpm install`          | Install workspace dependencies and Git hooks                   |
| `pnpm lint`             | Mobile ESLint; backend rustfmt and clippy with warnings denied |
| `pnpm format`           | Write Prettier formatting and Rust formatting                  |
| `pnpm format:check`     | Check Prettier-supported files; Rust formatting is in lint/CI  |
| `pnpm typecheck`        | Mobile TypeScript and backend `cargo check --all-targets`      |
| `pnpm test`             | Mobile Jest and backend Cargo unit/router tests                |
| `pnpm test:integration` | Backend real-service tests; set both service URLs              |
| `pnpm test:e2e`         | Backend HTTP smoke plus mobile Maestro (device/APK required)   |
| `pnpm build`            | Android JS/assets export and backend release binary            |
| `pnpm prepare`          | Reinstall lefthook hooks                                       |

Turborepo runs app tasks; integration/e2e are uncached. Use `pnpm --filter @taphoa/backend`
or `pnpm --filter @taphoa/mobile` to target one app. Backend integration tests print a
skip when URLs are missing; a skip is **not** evidence of a passing real-service test.

## Test levels

| Level       | Mobile                                         | Backend                                                 | Requirements                                                |
| ----------- | ---------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Unit        | Jest + React Native Testing Library            | Cargo tests with mock Segmenter                         | No external services                                        |
| Integration | —                                              | Readiness, migrations, pgvector and dependency failures | Real Postgres + Redis, both URLs exported                   |
| Model       | —                                              | SAM encoder + 64 decoder prompts                        | Weights and ONNX Runtime; skips without models              |
| e2e         | Maestro smoke via EAS Workflow or local device | HTTP health/readiness/segmentation smoke                | APK/device for mobile; running API + services for backend   |
| Build       | `expo export` JS/assets; EAS native APK        | Release binary and multi-stage Docker image             | Docker for container build; EAS account for native workflow |

## Hooks and CI

`pnpm install` installs lefthook. Pre-commit runs Prettier on staged JS/TS/JSON/Markdown/YAML
and rustfmt when backend files are staged. Commit messages must follow Conventional
Commits, for example `chore: configure local stack`. Pre-push runs root lint,
typecheck and unit tests. Hook references: [lefthook](https://lefthook.dev/installation/node/)
and [commitlint](https://commitlint.js.org/guides/local-setup.html).

GitHub CI runs on pull requests and pushes to `main`: mobile checks/export, Rust
fmt/clippy/tests, integration against pgvector + Redis service containers, model-free
Docker HTTP e2e, and actionlint. New runs cancel older CI runs on the same ref.
Production deployment follows successful **push-to-main CI** and checks out that tested
revision. EAS native builds/Maestro remain in `apps/mobile/.eas/workflows/`.
See [deployment setup and credentials](docs/deploy.md). Dependabot checks npm, Cargo,
GitHub Actions, Dockerfiles and Compose images weekly.

No repository license has been selected.
