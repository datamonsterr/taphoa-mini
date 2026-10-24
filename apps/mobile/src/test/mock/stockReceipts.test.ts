import * as api from '@/lib/api';
import { newUuid } from '@/lib/uuid';

import { getMockDb, getProduct, registerImage, resetMockDb } from './db';
import { PRODUCT_IDS } from './fixtures';
import { getMockEvents } from './events';
import { createMockFetch } from './fetch';
import { setNextScanDocument } from './scenario';

beforeEach(resetMockDb);
const sell = (id: string, quantity: number, unitId?: string) =>
  api.createSale({
    id: newUuid(),
    sold_at: new Date().toISOString(),
    payment_method: 'transfer',
    total: quantity * 10000,
    lines: [
      {
        id: newUuid(),
        product_id: id,
        unit_id: unitId,
        quantity,
        unit_price: 10000,
        source: 'grid',
      },
    ],
  });

test('sales subtract base units, record ledger once, leave untracked stock null and emit one alert per crossing', async () => {
  await api.adjustStock(PRODUCT_IDS.coca, { count: 7 });
  const sale = await sell(PRODUCT_IDS.coca, 2);
  expect(getProduct(PRODUCT_IDS.coca).stock_quantity).toBe(5);
  expect(
    (await api.listStockMovements(PRODUCT_IDS.coca)).items[0],
  ).toMatchObject({
    delta: -2,
    quantity_after: 5,
    reason: 'sale',
    ref_id: sale.id,
  });
  await api.createSale({
    id: sale.id,
    sold_at: sale.sold_at,
    payment_method: 'transfer',
    total: sale.total,
    lines: sale.lines,
  });
  await sell(PRODUCT_IDS.coca, 1);
  expect(getMockEvents().filter((e) => e.type === 'stock.low')).toHaveLength(1);
  await api.adjustStock(PRODUCT_IDS.coca, { count: 8 });
  await sell(PRODUCT_IDS.coca, 4);
  expect(getMockEvents().filter((e) => e.type === 'stock.low')).toHaveLength(2);
  expect(getMockEvents().find((e) => e.type === 'stock.low')).toMatchObject({
    data: {
      product_id: PRODUCT_IDS.coca,
      name: 'Coca-Cola lon 330ml',
      stock_quantity: 5,
      threshold: 5,
    },
  });
  await sell(PRODUCT_IDS.lavie, 1);
  expect(getProduct(PRODUCT_IDS.lavie).stock_quantity).toBeNull();
  expect((await api.listStockMovements(PRODUCT_IDS.lavie)).items).toHaveLength(
    0,
  );
  const unit = getProduct(PRODUCT_IDS.coca).units[0]!;
  await sell(PRODUCT_IDS.coca, 1, unit.id);
  expect(getProduct(PRODUCT_IDS.coca).stock_quantity).toBe(-20);
});

test('failed sale and invalid confirmation leave stock, expenses and receipts intact', async () => {
  const quantity = getProduct(PRODUCT_IDS.coca).stock_quantity;
  await expect(
    api.createSale({
      id: newUuid(),
      sold_at: new Date().toISOString(),
      payment_method: 'transfer',
      total: 1,
      lines: [
        {
          id: newUuid(),
          product_id: PRODUCT_IDS.coca,
          quantity: 1,
          unit_price: 10000,
          source: 'grid',
        },
      ],
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(getProduct(PRODUCT_IDS.coca).stock_quantity).toBe(quantity);
  const image = registerImage({ contentType: 'image/jpeg', byteSize: 100 });
  const receipt = await api.createReceipt({ image_id: image.id });
  const expenses = getMockDb().expenses.length;
  await expect(
    api.confirmReceipt(receipt.id, {
      lines: [
        { product_id: PRODUCT_IDS.coca, quantity: 2, cost: 10 },
        { product_id: newUuid(), quantity: 2, cost: 10 },
      ],
      paid_with: 'cash_box',
    }),
  ).rejects.toMatchObject({ status: 422 });
  expect(getMockDb().expenses).toHaveLength(expenses);
  expect(getProduct(PRODUCT_IDS.coca).stock_quantity).toBe(quantity);
  expect((await api.getReceipt(receipt.id)).status).toBe('draft');
});

test('receipt confirmation initializes untracked stock and emits receipt confirmation', async () => {
  const image = registerImage({ contentType: 'image/jpeg', byteSize: 100 });
  const receipt = await api.createReceipt({ image_id: image.id });
  await api.confirmReceipt(receipt.id, {
    lines: receipt.lines.slice(0, 3).map((l) => ({
      product_id: l.product_id!,
      quantity: l.quantity,
      cost: l.cost,
    })),
    paid_with: 'cash_box',
  });
  expect(getProduct(PRODUCT_IDS.aquafina).stock_quantity).toBe(12);
  expect(getProduct(PRODUCT_IDS.coca).stock_quantity).toBe(44);
  expect(
    getMockEvents().filter((e) => e.type === 'receipt.confirmed'),
  ).toHaveLength(1);
});

test('document scans can be selected once or recognized from uploaded receipt filename', async () => {
  const jpeg = () => new Blob(['x'], { type: 'image/jpeg' });
  setNextScanDocument();
  expect((await api.createScan({ image: jpeg() })).document).toMatchObject({
    detected: true,
    text_lines: 12,
  });
  expect((await api.createScan({ image: jpeg() })).document.detected).toBe(
    false,
  );
  const form = new FormData();
  form.append('image', jpeg(), 'receipt.jpg');
  const response = await createMockFetch()(
    new Request('http://mock.local/v1/images', { method: 'POST', body: form }),
  );
  const upload = (await response.json()) as api.Image;
  expect(
    (await api.createScan({ image_id: upload.id })).document.detected,
  ).toBe(true);
  resetMockDb();
  expect(getMockEvents()).toHaveLength(0);
});
