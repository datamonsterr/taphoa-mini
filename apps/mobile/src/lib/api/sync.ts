import { getApiClient } from './client';
import { unwrap } from './errors';
import type { ChangeFeed } from './types';

/**
 * One page of `/v1/sync/changes`. Without `since` it is a full snapshot; repeat with the returned
 * `cursor` while `has_more`. A 410 (`ApiError.status`) means the cursor is older than the
 * compacted log: drop the local catalog and start again without `since`.
 */
export const pullChanges = (
  since?: string | null,
  limit = 500,
): Promise<ChangeFeed> =>
  unwrap(
    getApiClient().raw.GET('/v1/sync/changes', {
      params: { query: { limit, ...(since ? { since } : {}) } },
    }),
  );
