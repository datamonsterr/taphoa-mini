import { describe, expect, it } from 'vitest';
import { assertErrorResponse, createStore } from '../src/helpers.js';

function fields(value: unknown, shape: Record<string, string>) {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  const object = value as Record<string, unknown>;
  expect(Object.keys(object).sort()).toEqual(Object.keys(shape).sort());
  for (const [key, type] of Object.entries(shape)) {
    if (type.endsWith('?') && object[key] === null) continue;
    const base = type.replace(/\?$/, '');
    if (base === 'date') {
      expect(object[key]).toBeTypeOf('string');
      expect(Number.isNaN(Date.parse(object[key] as string))).toBe(false);
    } else if (base === 'integer') {
      expect(Number.isInteger(object[key])).toBe(true);
    } else if (base === 'array') {
      expect(Array.isArray(object[key])).toBe(true);
    } else {
      expect(typeof object[key]).toBe(base);
      if (base === 'object') expect(object[key]).not.toBeNull();
    }
  }
}

describe('daily digest against the deployed backend', () => {
  it('generates, caches, and validates daily digest parameters', async () => {
    const { client } = await createStore();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(new Date());

    // 1. Initial digest call on a fresh store -> 200
    const firstRes = await client.raw.GET('/v1/assistant/digest');
    expect(firstRes.response.status).toBe(200);
    expect(firstRes.data).toBeDefined();

    fields(firstRes.data, {
      business_date: 'string',
      generated_at: 'date',
      source: 'string',
      summary_vi: 'string',
      sales: 'object',
      restock: 'array',
      overdue_debts: 'object',
      open_drafts: 'object',
      read_at: 'date?',
    });

    expect(['model', 'template']).toContain(firstRes.data!.source);
    expect(typeof firstRes.data!.summary_vi).toBe('string');
    expect(firstRes.data!.summary_vi.trim().length).toBeGreaterThan(0);
    expect(firstRes.data!.sales.sale_count).toBe(0);
    expect(firstRes.data!.read_at).toBeNull();
    expect(firstRes.data!.business_date).toBe(today);

    // 2. A plain second call is cached (same generated_at) and still unread (#203)
    const plainRes = await client.raw.GET('/v1/assistant/digest');
    expect(plainRes.response.status).toBe(200);
    expect(plainRes.data!.generated_at).toBe(firstRes.data!.generated_at);
    expect(plainRes.data!.read_at ?? null).toBeNull();

    // Opening it (mark_read) records the read. That response still shows the state before
    // the open, so the next plain read is the one that carries the read_at date string.
    const openRes = await client.raw.GET('/v1/assistant/digest', {
      params: { query: { mark_read: true } },
    });
    expect(openRes.response.status).toBe(200);
    const secondRes = await client.raw.GET('/v1/assistant/digest');
    expect(secondRes.response.status).toBe(200);
    expect(secondRes.data).toBeDefined();
    expect(secondRes.data!.generated_at).toBe(firstRes.data!.generated_at);
    expect(typeof secondRes.data!.read_at).toBe('string');
    expect(Number.isNaN(Date.parse(secondRes.data!.read_at as string))).toBe(
      false,
    );

    // 3. Querying ungenerated past business date -> 404
    const notFound = await client.raw.GET('/v1/assistant/digest', {
      params: { query: { business_date: '2020-01-01' } },
    });
    expect(notFound.response.status).toBe(404);
    assertErrorResponse(notFound.error, 'not_found');

    // 4. Querying invalid business date format -> 400
    const invalidDate = await client.raw.GET('/v1/assistant/digest', {
      params: { query: { business_date: 'nope' } },
    });
    expect(invalidDate.response.status).toBe(400);
    assertErrorResponse(invalidDate.error, 'validation_failed');
  });

  it('omits digest chip from next steps before digest generation and after reading', async () => {
    const { client } = await createStore();

    // 1. Before digest call: no digest row exists -> no digest chip
    const beforeRes = await client.raw.GET('/v1/assistant/next-steps', {
      params: { query: { screen: 'camera' } },
    });
    expect(beforeRes.response.status).toBe(200);
    expect(beforeRes.data).toBeDefined();
    expect(
      beforeRes.data!.items.some(
        (item) => item.kind === 'digest' || item.id.startsWith('digest'),
      ),
    ).toBe(false);

    // 2. Generate and mark read. A plain GET no longer marks it read (#203); opening it does.
    const digestRes = await client.raw.GET('/v1/assistant/digest', {
      params: { query: { mark_read: true } },
    });
    expect(digestRes.response.status).toBe(200);

    // 3. After digest call: member has already read it -> digest chip remains absent
    const afterRes = await client.raw.GET('/v1/assistant/next-steps', {
      params: { query: { screen: 'camera' } },
    });
    expect(afterRes.response.status).toBe(200);
    expect(afterRes.data).toBeDefined();
    expect(
      afterRes.data!.items.some(
        (item) => item.kind === 'digest' || item.id.startsWith('digest'),
      ),
    ).toBe(false);
  });
});
