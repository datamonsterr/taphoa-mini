# ADR 0009: Offline storage is the persisted TanStack Query cache plus a small sale outbox, not SQLite

Status: Accepted · Date: 2026-10-28 · Issue: [#87](https://github.com/datamonsterr/taphoa-mini/issues/87) · PRD NFR "Offline"

## Context

The PRD promises that without internet the grid, manual price, catalog and VietQR still work and
that sales sync later. The backend side exists: `GET /v1/sync/changes` (cursor feed of store,
member, category, product, customer and debt-entry changes, 410 when the cursor is older than the
compacted log) and `POST /v1/sales`, idempotent on the sale `id` (`Idempotency-Key`, 200 on a
replay, 201 on first create). The `openapi.yaml` text still says phones "read the catalog from
local SQLite"; this ADR replaces that sentence. The app has to run on Android and on web (the
Playwright `e2e-web` suite exercises the web export), and the memory-tight CI and dev hosts make
extra native modules costly.

Two options were weighed:

|                               | Persisted TanStack Query cache (AsyncStorage)                                      | SQLite (`expo-sqlite`)                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Android                       | works                                                                              | works                                                                                                          |
| Web                           | works (AsyncStorage maps to `localStorage`)                                        | needs the experimental wa-sqlite/OPFS build, cross-origin isolation headers, a second schema in the web export |
| Fit with screens              | screens already read through `useQuery`; offline just means "the cache is on disk" | every screen read would move to a local database layer, or be mirrored into it                                 |
| Delta merge                   | merge change pages into one snapshot map and patch cached lists                    | natural upserts and indexes                                                                                    |
| Search, joins, large catalogs | linear filter of an in-memory map                                                  | indexed queries                                                                                                |
| New native code               | `@react-native-community/netinfo` only                                             | `expo-sqlite` plus migrations                                                                                  |

## Decision

**Persisted TanStack Query cache.** `PersistQueryClientProvider` with an AsyncStorage persister
saves a whitelist of query roots (`me`, `store`, `categories`, `products`, `catalog`,
`customers`, `cache-identity`) with a 7-day `maxAge`; the query client uses a matching `gcTime`.
Nothing else is persisted: reports, sales lists and debt screens need the server.

- **Catalog.** Products live in the paged lists the screens read and in one snapshot map
  (`keys.catalog()`: cursor plus products by id) that answers searches while offline. A sync pulls
  `/v1/sync/changes` from the stored cursor until `has_more` is false and merges: upserts patch
  the snapshot and every cached list and detail, deletes and archived products are removed, a new
  product invalidates the lists, a `store` change replaces the cached store (so the bank account
  for VietQR stays current), a 410 drops the snapshot and pulls it again. Syncing runs at start,
  on reconnect and when the app returns to the foreground, after the outbox has drained.
- **Identity.** The cache is stamped with `person:store` (`cache-identity`). On a cold start the
  same identity keeps the restored cache; any other identity clears it, as `AuthGate` did before.
- **Images.** Photos use `expo-image` with `cachePolicy="memory-disk"` and a `cacheKey` equal to
  the url without its presigned query string, so a photo stays on disk across sessions.
- **Online state.** `onlineManager` is fed by NetInfo (`isConnected` only; NetInfo's reachability
  probe is off). `useOnline()` exposes it.
- **Sale outbox** (`src/lib/outbox`). A zustand store persisted in AsyncStorage (`taphoa-outbox`)
  holds items `{ key, kind, payload, storeId, createdAt, attempts, nextAttemptAt, status, error }`.
  `PayScreen` records every cash, transfer and credit sale there with the sale `id` as the
  idempotency key, generated on the device, and shows success at once; local stock drops
  optimistically. Replay is oldest first when online: success (200 or 201) removes the item;
  network errors, 5xx, 401, 408, 425 and 429 retry with exponential backoff (2 s doubling to
  5 min) and hold the queue so order is kept; any other 4xx marks the item `failed`, stops
  retrying it and shows it to the seller (send again or discard) while the queue moves on. A replay
  after a lost response uses the same key and body, so the server answers 200 and nothing posts
  twice.
- **Generic by design.** The queue knows only `kind`, `payload` and `key`. A handler registered
  per kind sends it. The voice program ([#69](https://github.com/datamonsterr/taphoa-mini/issues/69),
  ADR 0008) adds a `voice` kind later: the payload holds the clip's file uri and metadata, the key
  is a client UUID, and the handler uploads the clip and records the parsed draft. No change to
  the queue, persistence, backoff or UI is needed.

## Consequences

- One storage mechanism for reads, one small queue for writes; the web build behaves like the
  phone, which lets Playwright test the offline sale for real.
- The catalog is held twice (lists and snapshot). Past roughly 2 000 products, or when an
  indexed query is needed (barcode scan, fuzzy search offline), move the snapshot to
  `expo-sqlite`; the sync module (`src/lib/offline/catalog.ts`) is the only code that would change.
- `localStorage` on web caps at about 5 MB; a write that does not fit is retried once without the
  paged product and customer lists (the catalog snapshot still serves the grid and searches).
- Cold start while offline still depends on Clerk restoring its session from the token cache;
  that is outside this ADR.
- Stock after a sale is exact only once the outbox has drained and products were refetched; until
  then the shown stock is the optimistic one.
