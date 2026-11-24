import { QueryClient } from '@tanstack/react-query';
import { useLowStockAlerts } from '@/stores/lowStockAlerts';
import { applyStoreEvent } from './events';
import { EventStream, SseParser, reconnectDelay } from './eventStream';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test('parses split frames, comments, multiline data and CRLF', () => {
  const receive = jest.fn();
  const parser = new SseParser(receive);
  parser.push(
    ': ping\r\nid: evt_000000000000001\r\nevent: stock.low\r\ndata: {"a":\r\n',
  );
  parser.push('data: 1}\r\n\r\n');
  expect(receive).toHaveBeenCalledWith(
    'stock.low',
    '{"a":\n1}',
    'evt_000000000000001',
  );
});

test('backoff grows, caps and includes jitter', () => {
  expect(reconnectDelay(0, 0)).toBe(500);
  expect(reconnectDelay(1, 1)).toBe(3000);
  expect(reconnectDelay(20, 1)).toBe(45000);
});

test('dispatches events, resumes, refreshes token on 401 and stops', async () => {
  jest.useFakeTimers();
  const tokens = jest.fn(async (refresh?: boolean) =>
    refresh ? 'fresh' : 'token',
  );
  const queryClient = new QueryClient();
  const dispatch = jest.fn((event) => applyStoreEvent(queryClient, event));
  const connected = jest.fn();
  const requests: { headers: Record<string, string>; signal: AbortSignal }[] =
    [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const transport = jest.fn(
    async (
      _url: string,
      init: { headers: Record<string, string>; signal: AbortSignal },
    ) => {
      requests.push(init);
      if (requests.length === 2) return { status: 401, ok: false, body: null };
      return {
        status: 200,
        ok: true,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        }),
      };
    },
  );
  const stream = new EventStream({
    url: 'http://api/v1/events',
    storeId: 'store',
    token: tokens,
    transport,
    dispatch,
    connected,
    random: () => 0,
  });
  stream.start();
  await flush();
  controller.enqueue(
    new TextEncoder().encode(
      'id: evt_000000000000001\nevent: stock.low\ndata: {"type":"stock.low","occurred_at":"now","data":{"product_id":"p","name":"Milk","stock_quantity":1,"threshold":5}}\n\n',
    ),
  );
  await flush();
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'stock.low' }),
  );
  expect(useLowStockAlerts.getState().alerts).toEqual([
    expect.objectContaining({ product_id: 'p', name: 'Milk' }),
  ]);
  controller.close();
  await flush();
  await jest.advanceTimersByTimeAsync(500);
  await flush();
  expect(requests[1]?.headers['Last-Event-ID']).toBe('evt_000000000000001');
  expect(tokens).toHaveBeenCalledWith(true);
  expect(requests[2]?.headers.Authorization).toBe('Bearer fresh');
  expect(connected).toHaveBeenCalledTimes(2);
  stream.stop();
  expect(requests[2]?.signal.aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(60000);
  expect(requests).toHaveLength(3);
  jest.useRealTimers();
});
