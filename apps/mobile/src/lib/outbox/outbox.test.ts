import AsyncStorage from '@react-native-async-storage/async-storage';
import { onlineManager } from '@tanstack/react-query';

import { ApiError, getProduct, listSales, setApiTransport } from '@/lib/api';
import type { CreateSaleRequest } from '@/lib/api';
import { createTestQueryClient } from '@/test/render';
import { PRODUCT_IDS } from '@/test/mock';
import { createMockFetch } from '@/test/mock/fetch';
import { newUuid } from '@/lib/uuid';

import {
  BACKOFF_BASE_MS,
  backoffMs,
  discardOutboxItem,
  enqueue,
  flushOutbox,
  isRetryable,
  pendingItems,
  registerOutboxHandler,
  resetOutbox,
  retryOutboxItem,
} from './outbox';
import { enqueueSale } from './sale';
import { OUTBOX_STORAGE_KEY, useOutboxStore } from './store';

const sent: string[] = [];
const results = new Map<string, unknown[]>();
const onFailed = jest.fn();

registerOutboxHandler('test', {
  send: async (payload, key) => {
    sent.push(key);
    const next = results.get(key)?.shift();
    if (next instanceof Error) throw next;
    return payload;
  },
  onFailed,
});

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-28T08:00:00Z') });
  sent.length = 0;
  results.clear();
  onFailed.mockClear();
  resetOutbox();
  onlineManager.setOnline(true);
});

const apiError = (status: number) =>
  new ApiError(status, { error: `HTTP ${status}` });

describe('outbox', () => {
  it('stores the item with its device-generated key and sends it', async () => {
    await enqueue({ kind: 'test', payload: { a: 1 }, key: 'k1' });
    await flushOutbox();
    expect(sent).toEqual(['k1']);
    expect(pendingItems()).toEqual([]);
  });

  it('persists the queue to storage while the server is unreachable', async () => {
    onlineManager.setOnline(false);
    await enqueue({ kind: 'test', payload: { a: 1 }, key: 'k1' });
    await jest.advanceTimersByTimeAsync(10);
    const stored = JSON.parse(
      (await AsyncStorage.getItem(OUTBOX_STORAGE_KEY))!,
    );
    expect(stored.state.items).toMatchObject([
      { key: 'k1', kind: 'test', status: 'pending', payload: { a: 1 } },
    ]);
    expect(sent).toEqual([]);
  });

  it('sends nothing while offline and replays in order on reconnect', async () => {
    onlineManager.setOnline(false);
    await enqueue({ kind: 'test', payload: 1, key: 'a', now: 1 });
    await enqueue({ kind: 'test', payload: 2, key: 'b', now: 2 });
    await flushOutbox();
    expect(sent).toEqual([]);
    onlineManager.setOnline(true);
    await flushOutbox();
    expect(sent).toEqual(['a', 'b']);
  });

  it('keeps one item per key', async () => {
    onlineManager.setOnline(false);
    await enqueue({ kind: 'test', payload: 1, key: 'a' });
    await enqueue({ kind: 'test', payload: 2, key: 'a' });
    expect(pendingItems()).toHaveLength(1);
  });

  it('retries a network error with backoff and holds later items to keep order', async () => {
    results.set('a', [new TypeError('Network request failed')]);
    await enqueue({ kind: 'test', payload: 1, key: 'a' });
    await enqueue({ kind: 'test', payload: 2, key: 'b' });
    await flushOutbox();
    expect(sent).toEqual(['a']);
    expect(pendingItems().map((i) => [i.key, i.attempts])).toEqual([
      ['a', 1],
      ['b', 0],
    ]);
    await jest.advanceTimersByTimeAsync(BACKOFF_BASE_MS - 1);
    expect(sent).toEqual(['a']);
    await jest.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['a', 'a', 'b']);
    expect(pendingItems()).toEqual([]);
  });

  it('grows the delay and caps it', () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([2_000, 4_000, 8_000]);
    expect(backoffMs(30)).toBe(300_000);
  });

  it('treats 5xx, 429 and 401 as retryable, other 4xx as permanent', () => {
    for (const status of [500, 503, 429, 408, 401])
      expect(isRetryable(apiError(status))).toBe(true);
    for (const status of [400, 403, 404, 409, 422])
      expect(isRetryable(apiError(status))).toBe(false);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });

  it('stops retrying a permanent 4xx, surfaces it and sends the next item', async () => {
    results.set('a', [apiError(400)]);
    await enqueue({ kind: 'test', payload: 1, key: 'a' });
    await enqueue({ kind: 'test', payload: 2, key: 'b' });
    await flushOutbox();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual(['a', 'b']);
    const [failed] = useOutboxStore.getState().items;
    expect(failed).toMatchObject({
      key: 'a',
      status: 'failed',
      error: { status: 400 },
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('puts a failed item back in line on retry and drops it on discard', async () => {
    results.set('a', [apiError(409)]);
    await enqueue({ kind: 'test', payload: 1, key: 'a' });
    await flushOutbox();
    retryOutboxItem('a');
    await flushOutbox();
    expect(sent).toEqual(['a', 'a']);
    expect(useOutboxStore.getState().items).toEqual([]);
    results.set('b', [apiError(400)]);
    await enqueue({ kind: 'test', payload: 1, key: 'b' });
    await flushOutbox();
    discardOutboxItem('b');
    expect(useOutboxStore.getState().items).toEqual([]);
  });
});

const saleBody = async (quantity = 2): Promise<CreateSaleRequest> => {
  const product = await getProduct(PRODUCT_IDS.coca);
  return {
    id: newUuid(),
    sold_at: new Date().toISOString(),
    payment_method: 'cash',
    total: product.price * quantity,
    cash_received: product.price * quantity,
    lines: [
      {
        id: newUuid(),
        product_id: product.id,
        source: 'grid',
        quantity,
        unit_price: product.price,
      },
    ],
  };
};

describe('sale outbox', () => {
  beforeEach(() => jest.useRealTimers());

  it('posts a recorded sale once, with its id as the idempotency key', async () => {
    const seen: Request[] = [];
    const mock = createMockFetch();
    setApiTransport(((input: Request) => {
      seen.push(input.clone());
      return mock(input);
    }) as typeof fetch);
    const body = await saleBody();
    await enqueueSale(createTestQueryClient(), body);
    await flushOutbox();
    const posts = seen.filter(
      (r) => r.method === 'POST' && r.url.endsWith('/v1/sales'),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers.get('idempotency-key')).toBe(body.id);
    expect(pendingItems()).toEqual([]);
  });

  it('a duplicate replay after a lost response does not double-post', async () => {
    const mock = createMockFetch();
    let calls = 0;
    const statuses: number[] = [];
    setApiTransport((async (input: Request) => {
      const response = await mock(input);
      if (input.method === 'POST' && input.url.endsWith('/v1/sales')) {
        calls += 1;
        statuses.push(response.status);
        if (calls === 1) throw new TypeError('response lost');
      }
      return response;
    }) as typeof fetch);
    const body = await saleBody();
    await enqueueSale(createTestQueryClient(), body);
    await flushOutbox();
    expect(pendingItems()).toHaveLength(1);
    useOutboxStore.setState((s) => ({
      items: s.items.map((i) => ({ ...i, nextAttemptAt: 0 })),
    }));
    await flushOutbox();
    expect(statuses).toEqual([201, 200]);
    expect(pendingItems()).toEqual([]);
    const { items } = await listSales({ limit: 200 });
    expect(items.filter((s) => s.id === body.id)).toHaveLength(1);
  });

  it('records the same sale only once and takes its stock off the cached product once', async () => {
    onlineManager.setOnline(false);
    const qc = createTestQueryClient();
    const product = await getProduct(PRODUCT_IDS.coca);
    qc.setQueryData(['api', 'products', 'detail', product.id], product);
    const body = await saleBody(2);
    await enqueueSale(qc, body);
    await enqueueSale(qc, body);
    expect(pendingItems()).toHaveLength(1);
    const cached = qc.getQueryData<typeof product>([
      'api',
      'products',
      'detail',
      product.id,
    ]);
    expect(cached!.stock_quantity).toBe((product.stock_quantity ?? 0) - 2);
  });

  it('a refused sale (400) is shown as failed and not retried', async () => {
    const body = await saleBody();
    const calls: string[] = [];
    setApiTransport((async (input: Request) => {
      calls.push(input.method);
      return new Response(JSON.stringify({ error: 'bad total' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
    await enqueueSale(createTestQueryClient(), body);
    await flushOutbox();
    await flushOutbox();
    expect(calls).toEqual(['POST']);
    expect(useOutboxStore.getState().items[0]).toMatchObject({
      status: 'failed',
      error: { status: 400, message: 'bad total' },
    });
  });
});
