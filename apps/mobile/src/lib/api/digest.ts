import type { paths } from '@taphoa/api-client';

import { getApiClient } from './client';
import { unwrap } from './errors';
import type { Digest } from './types';

export type GetDigestParams = NonNullable<
  paths['/v1/assistant/digest']['get']['parameters']['query']
>;

export const getDigest = (businessDate?: string): Promise<Digest> =>
  unwrap(
    getApiClient().raw.GET('/v1/assistant/digest', {
      params: {
        query: businessDate ? { business_date: businessDate } : undefined,
      },
    }),
  );
