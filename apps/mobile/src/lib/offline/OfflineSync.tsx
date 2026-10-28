import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { installOnlineManager, useOnline } from '@/lib/online';
import {
  bindOutboxClient,
  flushOutbox,
  reapplyPendingSales,
} from '@/lib/outbox';

import { syncCatalog } from './catalog';

installOnlineManager();

/**
 * Screens a grid sale needs. On web every route is its own chunk, so they are fetched while the
 * network is up; offline, opening the cart or the pay screen would otherwise fail to load.
 */
const SALE_ROUTES = ['/cart', '/pay'] as const;

/**
 * Keeps the device and the server level while a person with a store is signed in: unsent writes
 * go first (so the delta feed already contains them), then the catalog delta is pulled. Runs on
 * mount, on reconnect and when the app returns to the foreground.
 */
export function OfflineSync() {
  const qc = useQueryClient();
  const online = useOnline();

  useEffect(() => {
    bindOutboxClient(qc);
    if (!online) return undefined;
    for (const href of SALE_ROUTES) router.prefetch(href);
    const run = () => {
      void flushOutbox()
        .then(() => syncCatalog(qc, { afterMerge: reapplyPendingSales }))
        .catch(() => undefined);
    };
    run();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => sub.remove();
  }, [qc, online]);

  return null;
}
