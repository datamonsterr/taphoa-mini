import { useQueryClient } from '@tanstack/react-query';
import { fetch } from 'expo/fetch';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { clerkToken, membershipRequired } from './clerkBridge';
import { apiBaseUrl, apiConfigured } from './client';
import { EventStream } from './eventStream';
import { applyStoreEvent } from './events';
import { keys } from './keys';

export function useStoreEvents(storeId: string | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!storeId || !apiConfigured()) return;
    const stream = new EventStream({
      url: `${apiBaseUrl()}/v1/events`,
      storeId,
      token: (refresh) => clerkToken(refresh ? { skipCache: true } : undefined),
      transport: async (url, init) => {
        const response = await fetch(url, init);
        if (response.status === 403) membershipRequired();
        return response;
      },
      dispatch: (event) => applyStoreEvent(queryClient, event),
      connected: () => {
        for (const status of ['low', 'out'] as const)
          void queryClient.invalidateQueries({
            queryKey: keys.stock.list(status),
          });
      },
    });
    if (AppState.currentState === 'active') stream.start();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') stream.start();
      else stream.stop();
    });
    return () => {
      subscription.remove();
      stream.stop();
    };
  }, [storeId, queryClient]);
}
