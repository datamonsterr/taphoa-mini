import { QueryClient } from '@tanstack/react-query';

import { keys } from '@/lib/api/keys';

import { ApiError } from '@/lib/api/errors';

import { createAppQueryClient, revalidateRestoredMe } from './persist';

test('a restored `me` is stale again, other restored data keeps its freshness', async () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.me('user_1'), { memberships: [] });
  qc.setQueryData(keys.store(), { name: 'Tạp hóa' });
  await revalidateRestoredMe(qc);
  expect(qc.getQueryState(keys.me('user_1'))?.isInvalidated).toBe(true);
  expect(qc.getQueryState(keys.store())?.isInvalidated).toBe(false);
});

test('a 404 query fails at once; a 500 is retried', async () => {
  const qc = createAppQueryClient();
  const retry = qc.getDefaultOptions().queries?.retry as (
    count: number,
    error: unknown,
  ) => boolean;
  expect(retry(0, new ApiError(404, { error: 'sale not found' }))).toBe(false);
  expect(retry(0, new ApiError(403, { error: 'permission denied' }))).toBe(
    false,
  );
  expect(retry(0, new ApiError(500, { error: 'boom' }))).toBe(true);
  expect(retry(0, new ApiError(429, { error: 'slow' }))).toBe(true);
  expect(retry(0, new TypeError('Network request failed'))).toBe(true);
  expect(retry(3, new ApiError(500, { error: 'boom' }))).toBe(false);
});
