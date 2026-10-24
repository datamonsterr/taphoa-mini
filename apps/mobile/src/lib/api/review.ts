import { getApiClient } from './client';
import { unwrap } from './errors';
import type {
  ManualLine,
  ManualLineStatus,
  Page,
  ResolveManualLineInput,
} from './types';

/** Items sold without a catalog match, for the Lead to review. */
export function listManualLines(
  params: {
    status?: ManualLineStatus;
    limit?: number;
    cursor?: string | null;
  } = {},
): Promise<Page<ManualLine>> {
  const { cursor, ...rest } = params;
  return unwrap(
    getApiClient().raw.GET('/v1/review/manual-lines', {
      params: { query: { ...rest, ...(cursor ? { cursor } : {}) } },
    }),
  );
}

export const resolveManualLine = (
  lineId: string,
  body: ResolveManualLineInput,
): Promise<ManualLine> =>
  unwrap(
    getApiClient().raw.POST('/v1/review/manual-lines/{lineId}/resolve', {
      params: { path: { lineId } },
      body,
    }),
  );
