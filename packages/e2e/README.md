# @taphoa/e2e

API contract tests typed against `docs/api/openapi.yaml` through
`@taphoa/api-client`. Every case creates an isolated store and Clerk test identity.

## Unit tests and static checks

These commands require no credentials or running backend. `test` runs only
`src/**/*.test.ts` with mocked fetch; CI can safely run it by default.

```bash
pnpm --filter @taphoa/e2e test
pnpm --filter @taphoa/e2e typecheck
pnpm --filter @taphoa/e2e lint
pnpm exec prettier --check packages/e2e
```

Use the repository's Node 24 runtime.

## Live API tests

Start the backend and dependencies using the repository stack instructions. Supply
`CLERK_SECRET_KEY` through your shell or CI secret environment, for the same Clerk
**development instance** configured on the backend. The Backend API session creation
endpoint is testing-only and unavailable on production Clerk instances. Never put
credentials in source files or command-line arguments.

```bash
# CLERK_SECRET_KEY is already supplied in the environment.
BACKEND_URL=http://localhost:8080 pnpm --filter @taphoa/e2e test:e2e

# Select one suite while retaining global setup and cleanup:
BACKEND_URL=http://localhost:8080 pnpm --filter @taphoa/e2e exec vitest run --config vitest.e2e.config.ts tests/auth.test.ts
BACKEND_URL=http://localhost:8080 pnpm --filter @taphoa/e2e exec vitest run --config vitest.e2e.config.ts tests/devices.test.ts
BACKEND_URL=http://localhost:8080 pnpm --filter @taphoa/e2e exec vitest run --config vitest.e2e.config.ts tests/digest.test.ts
```

`BACKEND_URL` defaults to `http://localhost:8080` in the live config; set it to the
target backend URL for a remote run. Missing `CLERK_SECRET_KEY` fails clearly before
the live suites start. Optional `CLERK_API_URL` defaults to `https://api.clerk.com`.

`createClerkUser(opts?)` creates an `e2e-<unique>+clerk_test@example.com` identity,
then a Clerk session and a token valid for 3600 seconds. It returns
`{userId, email, sessionId, token, mint()}`; call `mint()` to obtain a new token for
long specs. `createStore(overrides?)` and `joinAsSeller(leadClient, options?)`
return `{client, session, storeName, user}` (plus `invite` for a seller).
`session.access_token` stays available to module specs; the session also carries
`member`, `store`, `clerk_user_id`, and `clerk_session_id`. Clients created by these
helpers send the bearer and the membership's `X-Store-Id`.

`newClient(token?, storeId?)` builds an optional identity/store client.
`authedClient(sessionOrToken, storeId?)` accepts a token or an object containing
`access_token`; it infers the store header when the object also contains `store`.
Use `newClient(token)` when testing identity-only requests or missing store headers.

Global setup creates a private, run-specific directory under `os.tmpdir()`.
Workers append only created user IDs to process-specific files there, so global
teardown can delete every identity even if its test fails. No secrets or tokens
are persisted. Teardown attempts every deletion and fails the run if cleanup
fails, retaining the ID files for diagnosis. A killed process can bypass teardown;
use the sweep for stale identities:

```bash
pnpm --filter @taphoa/e2e run clerk:sweep
pnpm --filter @taphoa/e2e run clerk:sweep --max-age-hours 48
```

The sweep uses the same secret environment and client. It lists Clerk users with
an email containing `+clerk_test`, keeps only addresses that also start with `e2e-`
(the harness and the docker smoke script create those), and deletes only users
older than the cutoff (24 hours by default). Seed users (`seed-*`) and eval users
are never touched. It gathers pages before deleting to avoid skipping records as
offsets shift. This covers e2e emails from other runs, so choose the cutoff to
exceed the longest active run.

## Rate limits and live timing

The Clerk client serializes request starts at 8 requests per second per process.
Set `CLERK_BAPI_RPS` to a positive number to tune this, usually downward when other
consumers share the development instance's **100 requests per 10 seconds** budget.
HTTP 429 waits `Retry-After` seconds (2 seconds when absent) and retries up to five
times. Separate suite processes share Clerk's budget; the limiter is process-local.

Backend auth limits are per IP. Use high store-create/join limits on the backend
under test, for example `RATE_LIMIT_STORE_CREATE_PER_HOUR=100000` and
`RATE_LIMIT_JOIN_PER_HOUR=100000`. PIN tests still exercise lockout. The expired
invite test waits the contract's minimum 60-second TTL and has a 90-second timeout.

Live files run sequentially because OCR, recognition, segmentation and indexing
share the backend inference slot. Receipt tests retain five-sample p95 <6000 ms
and skip only on `503 ocr_unavailable`; recognition retains its 3000 ms p95 budget.
These API tests do not prove browser sign-in or mobile session switching.
