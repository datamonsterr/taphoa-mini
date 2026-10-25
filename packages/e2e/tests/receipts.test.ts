import { randomUUID } from 'node:crypto';
import type { ApiClient, components } from '@taphoa/api-client';
import { describe, expect, it } from 'vitest';
import { createStore } from '../src/helpers.js';
import {
  catalogProduct,
  expectedReceipt,
  percentile,
  productPhoto,
  receiptPhoto,
  uuid7,
} from '../src/stock-fixtures.js';

async function scan(client: ApiClient, photo: Buffer) {
  for (let attempt = 0; ; attempt++) {
    const result = await client.raw.POST('/v1/recognition/scans', {
      body: { mode: 'multi', purpose: 'checkout' },
      bodySerializer: () => {
        const form = new FormData();
        form.set(
          'image',
          new File([new Uint8Array(photo)], 'scan.jpg', { type: 'image/jpeg' }),
        );
        form.set('mode', 'multi');
        form.set('purpose', 'checkout');
        return form;
      },
    });
    const retryAfter = result.response.headers.get('retry-after');
    if (result.response.status !== 503 || !retryAfter || attempt >= 5)
      return result;
    const seconds = Number(retryAfter);
    await new Promise((resolve) =>
      setTimeout(resolve, Number.isFinite(seconds) ? seconds * 1000 : 1000),
    );
  }
}

describe('receipt OCR against the deployed backend', () => {
  it('detects documents, parses five fresh drafts within 6s p95, and confirms its stock and expense', async (ctx) => {
    const { client } = await createStore();
    // Probe OCR first so a deliberately model-free backend has an explicit skip reason.
    const probe = await client.raw.POST('/v1/receipts', {
      params: { header: { 'Idempotency-Key': randomUUID() } },
      body: { image_id: randomUUID() },
    });
    if (
      probe.response.status === 503 &&
      probe.error?.code === 'ocr_unavailable'
    ) {
      const reason = 'Backend lacks receipt OCR models (503 ocr_unavailable).';
      console.warn(reason);
      ctx.skip(reason);
    }
    expect(probe.response.status, JSON.stringify(probe.error)).toBe(404);

    const products = [];
    for (const line of expectedReceipt.lines)
      products.push(await catalogProduct(client, line.product_name));
    const document = await scan(client, receiptPhoto);
    expect(document.response.status, JSON.stringify(document.error)).toBe(201);
    expect(document.data!.document.detected).toBe(true);
    expect(document.data!.purpose).toBe('checkout');
    const photo = await scan(client, productPhoto);
    expect(photo.response.status, JSON.stringify(photo.error)).toBe(201);
    expect(photo.data!.document.detected).toBe(false);

    const samples = [];
    const receipts: components['schemas']['Receipt'][] = [];
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      const draft = await client.raw.POST('/v1/receipts', {
        params: { header: { 'Idempotency-Key': randomUUID() } },
        body: { image_id: document.data!.image.id },
      });
      const wall = performance.now() - started;
      expect(draft.response.status, JSON.stringify(draft.error)).toBe(201);
      const receipt = draft.data!;
      samples.push({
        run: run + 1,
        wall_ms: wall,
        ...receipt.timings,
        parser: receipt.parser,
      });
      receipts.push(receipt);
    }
    console.table(samples);
    console.info(
      `receipt latency: wall p50=${percentile(
        samples.map((s) => s.wall_ms),
        0.5,
      ).toFixed(1)}ms p95=${percentile(
        samples.map((s) => s.wall_ms),
        0.95,
      ).toFixed(1)}ms; server p50=${percentile(
        samples.map((s) => s.total),
        0.5,
      )}ms p95=${percentile(
        samples.map((s) => s.total),
        0.95,
      )}ms`,
    );
    expect(new Set(receipts.map((r) => r.id)).size).toBe(5);
    expect(
      percentile(
        samples.map((s) => s.wall_ms),
        0.95,
      ),
    ).toBeLessThan(6000);
    for (const receipt of receipts) {
      expect(receipt.status).toBe('draft');
      expect(receipt.total).toBe(expectedReceipt.total);
      expect(
        receipt.lines.map(({ product_name, quantity, cost }) => ({
          product_name,
          quantity,
          cost,
        })),
      ).toEqual(expectedReceipt.lines);
      expect(receipt.lines.map((line) => line.product_id)).toEqual(
        products.map((p) => p.id),
      );
    }

    const draft = receipts[0]!;
    const confirmation = {
      params: {
        path: { receiptId: draft.id },
        header: { 'Idempotency-Key': randomUUID() },
      },
      body: {
        paid_with: 'other' as const,
        lines: draft.lines.map((line) => ({
          line_id: line.id,
          product_id: line.product_id!,
          quantity: line.quantity,
          cost: line.cost,
        })),
      },
    };
    const confirmed = await client.raw.POST(
      '/v1/receipts/{receiptId}/confirm',
      confirmation,
    );
    expect(confirmed.response.status, JSON.stringify(confirmed.error)).toBe(
      200,
    );
    expect(confirmed.data!.status).toBe('confirmed');
    expect(confirmed.data!.expense_id).toBeTruthy();
    const replay = await client.raw.POST(
      '/v1/receipts/{receiptId}/confirm',
      confirmation,
    );
    expect(replay.response.status, JSON.stringify(replay.error)).toBe(200);
    expect(replay.data!.expense_id).toBe(confirmed.data!.expense_id);
    const expense = await client.raw.GET('/v1/expenses/{expenseId}', {
      params: { path: { expenseId: confirmed.data!.expense_id! } },
    });
    expect(expense.response.status, JSON.stringify(expense.error)).toBe(200);
    expect(expense.data!.category).toBe('nhap_hang');
    expect(expense.data!.amount).toBe(expectedReceipt.total);
    expect(expense.data!.purchase_lines).toHaveLength(
      expectedReceipt.lines.length,
    );
    const stock = await client.raw.GET('/v1/stock');
    expect(stock.response.status, JSON.stringify(stock.error)).toBe(200);
    for (const [index, product] of products.entries()) {
      const line = expectedReceipt.lines[index]!;
      expect(
        stock.data!.items.find((item) => item.product_id === product.id)
          ?.stock_quantity,
      ).toBe(line.quantity);
      const movements = await client.raw.GET(
        '/v1/products/{productId}/stock-movements',
        { params: { path: { productId: product.id } } },
      );
      expect(movements.response.status, JSON.stringify(movements.error)).toBe(
        200,
      );
      expect(
        movements.data!.items.filter((m) => m.reason === 'receipt'),
      ).toEqual([
        expect.objectContaining({
          delta: line.quantity,
          quantity_after: line.quantity,
          ref_id: draft.id,
        }),
      ]);
    }
    const product = products[0]!;
    const threshold = expectedReceipt.lines[0]!.quantity - 1;
    const override = await client.raw.PATCH('/v1/products/{productId}', {
      params: { path: { productId: product.id } },
      body: { low_stock_threshold: threshold },
    });
    expect(override.response.status, JSON.stringify(override.error)).toBe(200);
    const saleId = uuid7();
    const sale = await client.raw.POST('/v1/sales', {
      headers: { 'Idempotency-Key': saleId },
      body: {
        id: saleId,
        sold_at: new Date().toISOString(),
        payment_method: 'cash',
        cash_received: product.price,
        total: product.price,
        lines: [
          {
            id: uuid7(),
            product_id: product.id,
            source: 'grid',
            quantity: 1,
            unit_price: product.price,
          },
        ],
      },
    });
    expect(sale.response.status, JSON.stringify(sale.error)).toBe(201);
    const low = await client.raw.GET('/v1/stock', {
      params: { query: { status: 'low' } },
    });
    expect(low.response.status, JSON.stringify(low.error)).toBe(200);
    expect(low.data!.items).toContainEqual(
      expect.objectContaining({
        product_id: product.id,
        stock_quantity: threshold,
        low_stock_threshold: threshold,
        status: 'low',
      }),
    );
  }, 120_000);
});
