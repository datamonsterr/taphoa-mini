import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type ProductUnit } from './index';

const unit: ProductUnit = {
  id: 'unit-a',
  name: 'lốc',
  quantity_in_base: 6,
  price: 55000,
  barcode: 'keep-me',
};
const sibling: ProductUnit = {
  ...unit,
  id: 'unit-b',
  name: 'thùng',
  quantity_in_base: 24,
  price: 220000,
};
function setup(
  response = new Response('{}', {
    headers: { 'Content-Type': 'application/json' },
  }),
) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (request: Request) => {
    requests.push(request);
    return response;
  });
  return {
    requests,
    api: createApiClient({
      baseUrl: 'https://test.invalid',
      getToken: () => 'token',
      getStoreId: () => 'store',
      fetch: fetch as typeof globalThis.fetch,
    }),
  };
}
describe('sale and export wrappers', () => {
  it('gets a sale with auth/store headers', async () => {
    const { api, requests } = setup();
    await api.getSale('sale-1');
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/sales/sale-1');
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer token');
    expect(requests[0]!.headers.get('X-Store-Id')).toBe('store');
  });
  it('posts the void reason and surfaces forbidden without retrying', async () => {
    const { api, requests } = setup(
      new Response('{"error":"forbidden"}', {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const result = await api.voidSale('sale-1', { reason: 'Khách trả hàng' });
    expect(result.response.status).toBe(403);
    expect(result.error).toEqual({ error: 'forbidden' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/sales/sale-1/void');
    expect(await requests[0]!.json()).toEqual({ reason: 'Khách trả hàng' });
  });
  it.each(['csv', 'xlsx'] as const)(
    'downloads %s without JSON decoding or binary corruption',
    async (format) => {
      const bytes = new Uint8Array([0x50, 0x4b, 0, 255, 0xc3, 0xa1]);
      const { api, requests } = setup(new Response(bytes));
      const result = await api.exportTransactions({
        from: '2026-10-01',
        to: '2026-10-27',
        format,
      });
      expect(new Uint8Array(result.data!)).toEqual(bytes);
      expect(
        Object.fromEntries(new URL(requests[0]!.url).searchParams),
      ).toEqual({ from: '2026-10-01', to: '2026-10-27', format });
      expect(requests[0]!.headers.get('X-Store-Id')).toBe('store');
    },
  );
});
describe('unit replacement wrappers', () => {
  it('creates while retaining siblings and barcode', async () => {
    const { api, requests } = setup();
    await api.createProductUnit('product', [sibling], unit);
    expect(requests[0]!.method).toBe('PATCH');
    expect(await requests[0]!.json()).toEqual({ units: [sibling, unit] });
  });
  it('updates only the selected unit', async () => {
    const { api, requests } = setup();
    const changed = { ...unit, price: 56000 };
    await api.updateProductUnit('product', [unit, sibling], changed);
    expect(await requests[0]!.json()).toEqual({ units: [changed, sibling] });
  });
  it('deletes only the selected unit', async () => {
    const { api, requests } = setup();
    await api.deleteProductUnit('product', [unit, sibling], unit.id);
    expect(await requests[0]!.json()).toEqual({ units: [sibling] });
  });
});
