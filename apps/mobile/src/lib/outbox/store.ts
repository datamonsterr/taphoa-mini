import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type OutboxStatus = 'pending' | 'failed';

/** One queued write. `payload` is JSON; large blobs (a voice clip) are stored as a file uri. */
export type OutboxItem = {
  /** Idempotency key, generated on the device when the item is recorded. */
  key: string;
  /** Selects the handler that sends it, e.g. `sale`; a voice program adds `voice`. */
  kind: string;
  payload: unknown;
  /** Store the item was recorded for; replay only runs while that store is current. */
  storeId: string | null;
  createdAt: number;
  attempts: number;
  /** Earliest time (ms epoch) of the next attempt. */
  nextAttemptAt: number;
  status: OutboxStatus;
  /** The permanent failure the seller must see. */
  error?: { status?: number; code?: string; message: string };
};

type OutboxState = { items: OutboxItem[] };

export const OUTBOX_STORAGE_KEY = 'taphoa-outbox';

/**
 * The queue survives restarts. Unlike preferences, storage errors are not swallowed on write:
 * a sale that did not persist must not look recorded.
 */
export const useOutboxStore = create<OutboxState>()(
  persist(() => ({ items: [] }) as OutboxState, {
    name: OUTBOX_STORAGE_KEY,
    version: 1,
    storage: createJSONStorage(() => AsyncStorage),
  }),
);

/** Resolves once the stored queue has been read; writes before that would be overwritten by it. */
export function outboxHydrated(): Promise<void> {
  if (useOutboxStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useOutboxStore.persist.onFinishHydration(() => {
      off();
      resolve();
    });
  });
}
