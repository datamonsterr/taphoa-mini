import { useQueryClient } from '@tanstack/react-query';
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
