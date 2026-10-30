/**
 * Persisted outbox: writes recorded on the device and sent to the server when it is reachable.
 *
 * - `enqueue({ kind, payload, key })` stores the item (idempotent on `key`) and tries to send.
 *   The key is generated on the device at record time and travels as `Idempotency-Key`, so a
 *   replay after a lost response cannot post twice; a server "already recorded" answer (200) is
 *   a success like 201.
 * - Handlers are registered per `kind` with `registerOutboxHandler`. The sale handler lives in
 *   `sale.ts`. The voice program (#69) adds a `voice` kind whose payload is the clip's file uri
 *   plus its metadata and whose handler uploads it, with no change to the queue itself.
 * - Items replay oldest first. A network error, 5xx, 401, 408, 425 or 429 stops the queue and
 *   retries with exponential backoff (`backoffMs`), so order is kept. Any other 4xx is permanent:
 *   the item becomes `failed`, stays in the store for the seller to see (`discardOutboxItem`,
 *   `retryOutboxItem`) and the queue moves on.
 * - `flushOutbox` runs on enqueue, on reconnect, on foreground and when a backoff timer fires.
 */
import { onlineManager } from '@tanstack/react-query';

import { isApiError } from '@/lib/api/errors';
import { currentStoreId } from '@/lib/api/clerkBridge';

import { outboxHydrated, useOutboxStore, type OutboxItem } from './store';

export type OutboxHandler = {
  /** Sends the item; resolves on success (including a server replay answer), throws otherwise. */
  send: (payload: unknown, key: string) => Promise<unknown>;
  onSent?: (item: OutboxItem) => void;
  /** Called once when the item turns permanently failed. */
  onFailed?: (item: OutboxItem) => void;
};

const handlers = new Map<string, OutboxHandler>();

export function registerOutboxHandler(kind: string, handler: OutboxHandler) {
  handlers.set(kind, handler);
}

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

/** Delay before attempt number `attempts + 1`: 2 s, 4 s, 8 s ... capped at 5 min. */
export const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));

const RETRYABLE_STATUS = new Set([401, 408, 425, 429]);

/** Whether a failed send may succeed later. Network errors are not `ApiError`s: they retry. */
export function isRetryable(error: unknown): boolean {
  if (!isApiError(error)) return true;
  return error.status >= 500 || RETRYABLE_STATUS.has(error.status);
}

const update = (key: string, patch: Partial<OutboxItem>) =>
  useOutboxStore.setState((state) => ({
    items: state.items.map((item) =>
      item.key === key ? { ...item, ...patch } : item,
    ),
  }));

export async function enqueue(input: {
  kind: string;
  payload: unknown;
  key: string;
  now?: number;
}): Promise<OutboxItem> {
  await outboxHydrated();
  const existing = useOutboxStore
    .getState()
    .items.find((item) => item.key === input.key);
  if (existing) return existing;
  const now = input.now ?? Date.now();
  const item: OutboxItem = {
    key: input.key,
    kind: input.kind,
    payload: input.payload,
    storeId: currentStoreId(),
    createdAt: now,
    attempts: 0,
    nextAttemptAt: now,
    status: 'pending',
  };
  useOutboxStore.setState((state) => ({ items: [...state.items, item] }));
  void flushOutbox();
  return item;
}

let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(at: number, now: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(
    () => {
      timer = null;
      void flushOutbox();
    },
    Math.max(0, at - now),
  );
}

async function run(now: () => number) {
  await outboxHydrated();
  for (;;) {
    if (!onlineManager.isOnline()) return;
    const store = currentStoreId();
    const [item] = useOutboxStore
      .getState()
      .items.filter(
        (it) =>
          it.status === 'pending' &&
          handlers.has(it.kind) &&
          (it.storeId === null ? store === null : it.storeId === store),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    if (!item) return;
    if (item.nextAttemptAt > now()) {
      schedule(item.nextAttemptAt, now());
      return;
    }
    const handler = handlers.get(item.kind)!;
    try {
      await handler.send(item.payload, item.key);
      useOutboxStore.setState((state) => ({
        items: state.items.filter((it) => it.key !== item.key),
      }));
      handler.onSent?.(item);
    } catch (error) {
      if (isRetryable(error)) {
        const attempts = item.attempts + 1;
        const retryAfter = isApiError(error) ? error.retryAfterMs : undefined;
        const next = now() + Math.max(retryAfter ?? 0, backoffMs(attempts));
        update(item.key, {
          attempts,
          nextAttemptAt: next,
          lastStatus: isApiError(error) ? error.status : undefined,
        });
        schedule(next, now());
        return;
      }
      const api = isApiError(error) ? error : undefined;
      const failed = {
        status: api?.status,
        code: api?.code,
        message: error instanceof Error ? error.message : String(error),
      };
      update(item.key, { status: 'failed', error: failed });
      handler.onFailed?.({ ...item, status: 'failed', error: failed });
    }
  }
}

/** Sends every due item in order. Single flight: a call during a run schedules one more pass. */
export function flushOutbox(now: () => number = Date.now): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await run(now);
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

export const discardOutboxItem = (key: string) =>
  useOutboxStore.setState((state) => ({
    items: state.items.filter((item) => item.key !== key),
  }));

/** Puts a failed item back in line (after the seller fixed the cause). */
export function retryOutboxItem(key: string) {
  update(key, {
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    error: undefined,
  });
  void flushOutbox();
}

export const pendingItems = (kind?: string): OutboxItem[] =>
  useOutboxStore
    .getState()
    .items.filter(
      (item) => item.status === 'pending' && (!kind || item.kind === kind),
    );

/** Test hook: empty the queue and the retry timer; handlers stay registered. */
export function resetOutbox() {
  if (timer) clearTimeout(timer);
  timer = null;
  useOutboxStore.setState({ items: [] });
}
