# @taphoa/e2e

End-to-end integration and contract test suite for the Tạp Hóa backend API (Epic E1).

Tests are written using [Vitest](https://vitest.dev) and typed against the OpenAPI 3.1 specification (`docs/api/openapi.yaml`) using `@taphoa/api-client`.

## Design Principles

- **DB State Independence & Idempotency:** Every test suite and test case creates its own isolated store via `createStore()`. No assumptions are made about existing database records, making tests safely runnable in parallel against shared local or remote databases.
- **Contract Fidelity:** Tests validate exact schemas, status codes, required fields, and error shapes (`{ error, code }`) according to `docs/api/openapi.yaml`.
- **Safe CI Default:** When `BACKEND_URL` is not set, `pnpm test` (and root `turbo run test`) skips e2e specs and exits with code 0.

## Running Tests

### 1. Against Local Docker Compose

Start the backend and dependencies (Postgres, Redis, RustFS):

```bash
docker compose up --build
```

The backend starts at `http://localhost:8080`.

To run the end-to-end test suite (defaults `BACKEND_URL` to `http://localhost:8080`):

```bash
pnpm --filter @taphoa/e2e test:e2e
```

Or from the repository root via Turborepo:

```bash
pnpm test:e2e
```

### 2. Against a Deployed Backend (e.g. Railway / Staging)

Provide the target service URL via `BACKEND_URL`:

```bash
BACKEND_URL=https://backend-production.up.railway.app pnpm --filter @taphoa/e2e test:e2e
```

Or with root `test:e2e`:

```bash
BACKEND_URL=https://backend-production.up.railway.app pnpm test:e2e
```

### 3. Running Specific Suites

You can target individual test files:

```bash
BACKEND_URL=http://localhost:8080 pnpm --filter @taphoa/e2e vitest run tests/auth.test.ts
BACKEND_URL=http://localhost:8080 pnpm --filter @taphoa/e2e vitest run tests/store.test.ts
BACKEND_URL=http://localhost:8080 pnpm --filter @taphoa/e2e vitest run tests/members.test.ts
BACKEND_URL=http://localhost:8080 pnpm --filter @taphoa/e2e vitest run tests/health.test.ts
```

`receipts.test.ts` uses real document detection, OCR and product mapping on the
receipt fixture, then verifies confirmation, its expense and stock ledger, and a
sale crossing a product threshold. Five fresh receipt drafts (distinct idempotency
keys, the scan's existing image) must have wall-time p95 below 6000 ms; server OCR,
decisions and total timings are printed for each run. It skips explicitly only on
`503 ocr_unavailable`. `stock.test.ts` also checks adjustments, per-product threshold
overrides and sale movements independently of OCR. Recognition keeps its existing
3000 ms scan p95 budget.

The live e2e config runs files sequentially because OCR, scans, segmentation and
catalog indexing share the backend inference slot. This prevents other suites
from competing with latency samples; each test still owns an isolated store.

## Available Scripts

| Script                                | Command                                    | Description                                                              |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `pnpm --filter @taphoa/e2e test`      | `node scripts/run-test.mjs`                | Runs vitest if `BACKEND_URL` is set; skips with exit code 0 if unset.    |
| `pnpm --filter @taphoa/e2e test:e2e`  | `vitest run --config vitest.e2e.config.ts` | Runs vitest against `BACKEND_URL` (defaults to `http://localhost:8080`). |
| `pnpm --filter @taphoa/e2e typecheck` | `tsc --noEmit`                             | Typechecks all source and test files.                                    |
| `pnpm --filter @taphoa/e2e lint`      | `tsc --noEmit`                             | TypeScript lint check.                                                   |

## Rate limits

Auth endpoints are rate limited per client IP and the IP cannot be spoofed from the client.
Run the backend under test with high limits, for example
`RATE_LIMIT_STORE_CREATE_PER_HOUR=100000 RATE_LIMIT_JOIN_PER_HOUR=100000 RATE_LIMIT_RECOVER_PER_10MIN=100000`
(docker compose already does). The PIN lockout spec still proves the 429 path.
