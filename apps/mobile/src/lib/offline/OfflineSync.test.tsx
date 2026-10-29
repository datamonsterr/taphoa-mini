import { act, render } from '@testing-library/react-native';
import { onlineManager, QueryClientProvider } from '@tanstack/react-query';

import { setApiTransport } from '@/lib/api';
import { enqueue, registerOutboxHandler, resetOutbox } from '@/lib/outbox';
import { createTestQueryClient } from '@/test/render';

import { OfflineSync } from './OfflineSync';

const mockPrefetch = jest.fn();
jest.mock('./saleScreens', () => ({
  prefetchSaleScreens: () => mockPrefetch(),
}));

test('on reconnect it sends unsent writes first, then pulls the catalog delta', async () => {
  const order: string[] = [];
  registerOutboxHandler('order', {
    send: async (_payload, key) => {
      order.push(`send ${key}`);
    },
  });
  setApiTransport((async (input: Request) => {
    order.push(new URL(input.url).pathname);
    return new Response(
      JSON.stringify({ changes: [], cursor: 'c1', has_more: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch);
  resetOutbox();
  const qc = createTestQueryClient();
  onlineManager.setOnline(false);
  await enqueue({ kind: 'order', payload: 1, key: 'k1' });
  await render(
    <QueryClientProvider client={qc}>
      <OfflineSync />
    </QueryClientProvider>,
  );
  expect(order).toEqual([]);
  await act(async () => onlineManager.setOnline(true));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(order).toEqual(['send k1', '/v1/sync/changes']);
  // the sale screens are fetched while online (web chunks), once the network is up
  expect(mockPrefetch).toHaveBeenCalledTimes(1);
});
