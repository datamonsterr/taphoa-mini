import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStore } from '../src/helpers.js';
import { catalogProduct, uuid7 } from '../src/stock-fixtures.js';

describe('stock against the deployed backend', () => {
  it('uses the product threshold override and subtracts a sale across the low-stock boundary', async () => {
    const { client } = await createStore();
    const product = await catalogProduct(client, 'Coca-Cola lon');
    const path = { productId: product.id };
    const override = await client.raw.PATCH('/v1/products/{productId}', {
      params: { path },
      body: { low_stock_threshold: 8 },
    });
    expect(override.response.status, JSON.stringify(override.error)).toBe(200);
    const adjustment = await client.raw.POST(
      '/v1/products/{productId}/stock-adjustments',
      {
        params: { path, header: { 'Idempotency-Key': randomUUID() } },
        body: { count: 10 },
      },
    );
    expect(adjustment.response.status, JSON.stringify(adjustment.error)).toBe(
      200,
    );
    const before = await client.raw.GET('/v1/stock', {
      params: { query: { status: 'low' } },
    });
    expect(before.response.status).toBe(200);
    expect(before.data!.items.map((item) => item.product_id)).not.toContain(
      product.id,
    );
    const saleId = uuid7();
    const sale = await client.raw.POST('/v1/sales', {
      headers: { 'Idempotency-Key': saleId },
      body: {
        id: saleId,
        sold_at: new Date().toISOString(),
        payment_method: 'cash',
        cash_received: 30000,
        total: 30000,
        lines: [
          {
            id: uuid7(),
            product_id: product.id,
            source: 'grid',
            quantity: 2,
            unit_price: 15000,
          },
        ],
      },
    });
    expect(sale.response.status, JSON.stringify(sale.error)).toBe(201);
    const low = await client.raw.GET('/v1/stock', {
      params: { query: { status: 'low' } },
    });
    expect(low.response.status, JSON.stringify(low.error)).toBe(200);
    expect(low.data!.items).toEqual([
      expect.objectContaining({
        product_id: product.id,
        stock_quantity: 8,
        low_stock_threshold: 8,
        status: 'low',
      }),
    ]);
    const movements = await client.raw.GET(
      '/v1/products/{productId}/stock-movements',
      { params: { path } },
    );
    expect(movements.response.status).toBe(200);
    expect(movements.data!.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'sale',
          delta: -2,
          quantity_after: 8,
          ref_id: saleId,
        }),
      ]),
    );
  });
});
