# Tạp Hóa Mini

Tạp Hóa Mini is a phone-first point-of-sale app for small family-run convenience stores in Vietnam. A shopkeeper photographs items on the counter; the planned app recognizes products, shows the total, displays a VietQR payment code, and records sales for end-of-day reconciliation. This repository currently contains the mobile/API infrastructure skeleton, including SAM segmentation; catalog, checkout, payments, and reports are future work. See the [PRD](docs/PRD.md) and [accepted setup spec](docs/specs/monorepo-setup.md).

## Layout

```text
apps/mobile/              Expo SDK 58, TypeScript, Expo Router
  .eas/workflows/          Android preview builds and EAS Hosting web deploy
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
| `pnpm api:generate`     | Regenerate `packages/api-client/src/schema.d.ts` from OpenAPI  |
| `pnpm lint:api`         | Redocly lint of `docs/api/openapi.yaml`                        |
| `pnpm lint:api:async`   | Validate `docs/api/asyncapi.yaml` (fetches AsyncAPI CLI)       |
| `pnpm mock:api`         | Prism mock server of the OpenAPI contract on port 4010         |
| `pnpm test:smoke:mock`  | Start Prism, call it through `@taphoa/api-client`, stop it     |

Turborepo runs app tasks; integration/e2e are uncached. Use `pnpm --filter @taphoa/backend`
or `pnpm --filter @taphoa/mobile` to target one app. Backend integration tests print a
skip when URLs are missing; a skip is **not** evidence of a passing real-service test.

## Contract-first workflow

`docs/api/openapi.yaml` is the source of truth. Change it first, then:

1. `pnpm lint:api` validates the contract (Redocly).
2. `pnpm api:generate` regenerates `packages/api-client/src/schema.d.ts`
   (openapi-typescript). Commit the result;
   `pnpm --filter @taphoa/api-client check:generated` fails on drift.
3. Use the typed client (`createApiClient` from `@taphoa/api-client`, built on
   openapi-fetch) in the mobile app; add a wrapper for each new operation.
4. `pnpm mock:api` serves the contract on `http://localhost:4010` so the app can be
   developed before the backend exists (`EXPO_PUBLIC_API_URL=http://localhost:4010`).
   `pnpm test:smoke:mock` runs the same flow headless.

The AsyncAPI document is validated with `pnpm lint:api:async`, which runs the AsyncAPI
CLI through `pnpm dlx` (about 1.5 minutes cold) instead of adding it as a dependency.

New mobile features follow `apps/mobile/src/features/checkout`: pure logic in a plain
module, a thin React hook on top, tests beside them.

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
`lint:api`, typecheck and unit tests. Hook references: [lefthook](https://lefthook.dev/installation/node/)
and [commitlint](https://commitlint.js.org/guides/local-setup.html).

GitHub CI runs on pull requests and pushes to `main` (new runs cancel older ones on
the same ref). `changes` (paths-filter) skips unaffected areas; many small jobs run in
parallel, each writing a job summary and uploading JUnit/logs artifacts on failure:

- Rust: `rust-fmt`, `rust-clippy`, `rust-build` (one `cargo nextest archive`), `rust-test`
  (2 nextest partitions from the archive; includes the contract tests against
  `docs/api/openapi.yaml`) and `rust-integration` (the `#[ignore]` tests from the same
  archive against pgvector Postgres, Redis and RustFS service containers).
- JavaScript: `js-format`, `js-lint`, `js-typecheck`, `js-test`, `js-build`, with pnpm and
  Turborepo caches; `api-contract` (Redocly + generated client) and `smoke-mock` (Prism).
- Docker: `docker-build` (buildx with GHA layer cache, image shared as an artifact) and
  `docker-e2e` (Compose smoke using that image).
- `actionlint`, `ci-scripts` (unit tests of `scripts/ci`) and the single required
  aggregate check `ci-ok`, which also prints a job timing table.

After CI is green on `main`, `deploy.yml` deploys to the Railway `test` environment,
seeds it, runs the e2e suite and latency probes, then deploys `production` and smokes it.
`workflow_dispatch` with a `ref` input deploys any branch to `test` only.
`railway-integration.yml` runs the ignored integration tests against the real Railway
`test` Postgres/Redis/bucket (manual, nightly, and on backend changes to `main`).
Railway steps are skipped with a notice while their secrets are unset.
EAS preview builds and web deploy live in `apps/mobile/.eas/workflows/`; Maestro runs in `android-e2e.yml`.
See [deployment setup and credentials](docs/deploy.md). Dependabot checks npm, Cargo,
GitHub Actions, Dockerfiles and Compose images weekly.

No repository license has been selected.
