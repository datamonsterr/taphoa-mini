import { onlineManager, type QueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { keys } from '@/lib/api/keys';
import { getMe } from '@/lib/api/store';

import { getClerkState } from './clerk';
import { createTestQueryClient, renderWithProviders } from './render';

/** Back online; call from `afterEach` so a test that went offline cannot leak into the next. */
export const restoreOnline = () => onlineManager.setOnline(true);

/**
 * Renders `ui` with the phone offline and nothing cached except the account (`/v1/me`, which a
 * real screen only mounts after the gate has loaded). Queries and mutations the screen starts
 * are paused by TanStack Query, exactly like a phone in airplane mode.
 */
export async function renderOffline(
  ui: ReactElement,
  queryClient: QueryClient = createTestQueryClient(),
) {
  onlineManager.setOnline(true);
  const { userId } = getClerkState();
  if (userId)
    await queryClient
      .fetchQuery({
        queryKey: keys.me(userId),
        queryFn: getMe,
        staleTime: 60_000,
      })
      .catch(() => undefined);
  onlineManager.setOnline(false);
  return renderWithProviders(ui, queryClient);
}
