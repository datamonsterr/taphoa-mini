import { onlineManager, useQueryClient } from '@tanstack/react-query';
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
    let foreground = AppState.currentState === 'active';
    let running = false;
    const sync = () => {
      const shouldRun =
        foreground &&
        onlineManager.isOnline() &&
        (typeof navigator === 'undefined' || navigator.onLine !== false);
      if (shouldRun === running) return;
      running = shouldRun;
      if (running) stream.start();
      else stream.stop();
    };
    const unsubscribe = onlineManager.subscribe(sync);
    const subscription = AppState.addEventListener('change', (state) => {
      foreground = state === 'active';
      sync();
    });
    sync();
    return () => {
      unsubscribe();
      subscription.remove();
      stream.stop();
    };
  }, [storeId, queryClient]);
}
