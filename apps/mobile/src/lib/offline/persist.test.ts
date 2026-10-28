import { QueryClient } from '@tanstack/react-query';

import { keys } from '@/lib/api/keys';

import { revalidateRestoredMe } from './persist';

test('a restored `me` is stale again, other restored data keeps its freshness', async () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.me('user_1'), { memberships: [] });
  qc.setQueryData(keys.store(), { name: 'Tạp hóa' });
  await revalidateRestoredMe(qc);
  expect(qc.getQueryState(keys.me('user_1'))?.isInvalidated).toBe(true);
  expect(qc.getQueryState(keys.store())?.isInvalidated).toBe(false);
});
