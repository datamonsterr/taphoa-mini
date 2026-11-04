import type { paths } from '@taphoa/api-client';

import { getApiClient } from './client';
import { unwrap } from './errors';
import type { Digest } from './types';

export type GetDigestParams = NonNullable<
  paths['/v1/assistant/digest']['get']['parameters']['query']
>;

/**
 * Reads the digest. Only the digest screen passes `markRead`: the dashboard card reads without
 * recording a read, so its "Mới" badge stays until the digest is opened.
 */
export const getDigest = (
  businessDate?: string,
  markRead = false,
): Promise<Digest> =>
  unwrap(
    getApiClient().raw.GET('/v1/assistant/digest', {
      params: {
        query:
          businessDate || markRead
            ? {
                ...(businessDate ? { business_date: businessDate } : {}),
                ...(markRead ? { mark_read: true } : {}),
              }
            : undefined,
      },
    }),
  );
