import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient, type Query } from '@tanstack/react-query';
import type { PersistQueryClientProviderProps } from '@tanstack/react-query-persist-client';

import { keys } from '@/lib/api/keys';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Cache older than this is dropped on restore; the seller is online at least weekly. */
export const CACHE_MAX_AGE_MS = 7 * DAY_MS;

/** Roots (second key element) kept on the device: what selling needs without a network. */
const PERSISTED = new Set([
  'me',
  'store',
  'categories',
  'products',
  'catalog',
  'customers',
  'cache-identity',
]);

export const shouldPersistQuery = (query: Query): boolean =>
  query.state.status === 'success' &&
  query.queryKey[0] === keys.all[0] &&
  PERSISTED.has(String(query.queryKey[1]));

export const CACHE_STORAGE_KEY = 'taphoa-query-cache';

export const queryPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: CACHE_STORAGE_KEY,
  throttleTime: 1_000,
  // A full storage (web `localStorage` holds about 5 MB) keeps the essentials: the catalog
  // snapshot answers the grid and searches without the paged lists.
  retry: ({ persistedClient, errorCount }) =>
    errorCount > 1
      ? undefined
      : {
          ...persistedClient,
          clientState: {
            ...persistedClient.clientState,
            queries: persistedClient.clientState.queries.filter(
              (q) => !['products', 'customers'].includes(String(q.queryKey[1])),
            ),
          },
        },
});

/** gcTime must reach maxAge or garbage collection drops entries before they are saved. */
export const createAppQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { gcTime: CACHE_MAX_AGE_MS } },
  });

export const persistOptions: PersistQueryClientProviderProps['persistOptions'] =
  {
    persister: queryPersister,
    maxAge: CACHE_MAX_AGE_MS,
    buster: 'v1',
    dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
  };
