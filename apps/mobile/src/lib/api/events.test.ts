import { createTestQueryClient } from '@/test/render';
import { useLowStockAlerts } from '@/stores/lowStockAlerts';

import { applyStoreEvent } from './events';
import { keys } from './keys';

beforeEach(() => useLowStockAlerts.setState({ alerts: [] }));
const at = '2026-10-25T01:00:00Z';

test('stock changes refresh stock, product and movement queries', () => {
  const qc = createTestQueryClient();
  const spy = jest.spyOn(qc, 'invalidateQueries');
  applyStoreEvent(qc, {
    type: 'stock.changed',
    occurred_at: at,
    data: { product_id: 'p', stock_quantity: 4, reason: 'sale' },
  });
  for (const key of [
    keys.stock.all(),
    keys.products.all(),
    keys.stockMovements('p'),
  ])
    expect(spy).toHaveBeenCalledWith({ queryKey: key });
});

test('low stock alerts use event time, replace duplicates and can be dismissed', () => {
  const qc = createTestQueryClient();
  const event = {
    type: 'stock.low' as const,
    occurred_at: at,
    data: { product_id: 'p', name: 'Coca', stock_quantity: 4, threshold: 5 },
  };
  applyStoreEvent(qc, event);
  applyStoreEvent(qc, { ...event, data: { ...event.data, stock_quantity: 2 } });
  expect(useLowStockAlerts.getState().alerts).toEqual([
    { ...event.data, stock_quantity: 2, at },
  ]);
  useLowStockAlerts.getState().dismiss('p');
  expect(useLowStockAlerts.getState().alerts).toEqual([]);
});

test('receipt confirmation refreshes receipts, indexed events retain existing behavior', () => {
  const qc = createTestQueryClient();
  const spy = jest.spyOn(qc, 'invalidateQueries');
  applyStoreEvent(qc, {
    type: 'receipt.confirmed',
    occurred_at: at,
    data: { receipt_id: 'r', expense_id: 'e', total: 10, line_count: 1 },
  });
  expect(spy).toHaveBeenCalledWith({ queryKey: keys.receipts.all() });
  qc.setQueryData(keys.products.detail('p'), {
    id: 'p',
    index_status: 'pending',
  });
  applyStoreEvent(qc, {
    type: 'product.indexed',
    occurred_at: at,
    data: { product_id: 'p', index_status: 'ready' },
  });
  expect(qc.getQueryData(keys.products.detail('p'))).toMatchObject({
    index_status: 'ready',
  });
});
