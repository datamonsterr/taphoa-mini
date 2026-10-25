import { describe, expect, it } from 'vitest';
import { actionOracleKey } from '../scorers/index.ts';
import { mkCase, money, names } from '../test-helpers.ts';
import { FakeOracle, resolveCase } from './provider.ts';

describe('FakeOracle', () => {
  it('returns the canned value of an oracle name', async () => {
    const oracle = new FakeOracle({ top: names('Coca', 'Pepsi') });
    expect(await oracle.value({ oracle: 'top' })).toEqual(
      names('Coca', 'Pepsi'),
    );
    expect(
      await oracle.value({ oracle: 'top', match: 'all_mentioned' }),
    ).toEqual(names('Coca', 'Pepsi'));
  });

  it('derives the same value for an unknown oracle every time', async () => {
    const a = new FakeOracle();
    const b = new FakeOracle();
    const first = await a.value({ oracle: 'unknown_thing' });
    expect(await a.value({ oracle: 'unknown_thing' })).toEqual(first);
    expect(await b.value({ oracle: 'unknown_thing' })).toEqual(first);
    expect(await a.value({ oracle: 'other_thing' })).not.toEqual(first);
  });

  it('picks the value kind from the oracle name', async () => {
    const oracle = new FakeOracle();
    expect((await oracle.value({ oracle: 'restock_top3_names' })).kind).toBe(
      'names',
    );
    expect((await oracle.value({ oracle: 'sale_count_today' })).kind).toBe(
      'count',
    );
    expect((await oracle.value({ oracle: 'margin_pct_cola' })).kind).toBe(
      'percent',
    );
    expect((await oracle.value({ oracle: 'revenue_week' })).kind).toBe('money');
  });

  it('varies by args', async () => {
    const oracle = new FakeOracle();
    const a = await oracle.value({ oracle: 'price', args: { product: 'A' } });
    const b = await oracle.value({ oracle: 'price', args: { product: 'B' } });
    expect(a).not.toEqual(b);
  });

  it('resolves a ref to a stable uuid', async () => {
    const oracle = new FakeOracle();
    const id = await oracle.resolveRef('product:Coca');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(await oracle.resolveRef('product:Coca')).toBe(id);
    expect(await oracle.resolveRef('product:Pepsi')).not.toBe(id);
  });
});

describe('resolveCase', () => {
  it('fills facts and denied in the order of the case', async () => {
    const oracle = new FakeOracle({
      a: names('X'),
      b: money(100),
      c: money(7),
    });
    const resolved = await resolveCase(
      mkCase({
        expect_facts: [
          { oracle: 'a', match: 'all_mentioned' },
          { oracle: 'b', match: 'number' },
        ],
        denied_facts: [{ oracle: 'c', match: 'any_mentioned' }],
      }),
      oracle,
    );
    expect(resolved.facts).toEqual([names('X'), money(100)]);
    expect(resolved.denied).toEqual([money(7)]);
    expect(resolved.refs).toEqual({});
    expect(resolved.actionOracles).toEqual({});
  });

  it('resolves refs and oracles used by the expected action', async () => {
    const oracle = new FakeOracle({ suggested: money(18000) });
    const resolved = await resolveCase(
      mkCase({
        expect_action: {
          kind: 'price_change',
          fields: {
            product_id: { ref: 'product:Coca' },
            new_price: { oracle: 'suggested', args: { product: 'Coca' } },
            note: { eq: 'x' },
          },
        },
      }),
      oracle,
    );
    expect(resolved.refs).toEqual({
      'product:Coca': await oracle.resolveRef('product:Coca'),
    });
    expect(
      resolved.actionOracles[actionOracleKey('suggested', { product: 'Coca' })],
    ).toEqual(money(18000));
  });

  it('returns empty parts for a case without oracles', async () => {
    const resolved = await resolveCase(mkCase(), new FakeOracle());
    expect(resolved).toEqual({
      facts: [],
      denied: [],
      refs: {},
      actionOracles: {},
    });
  });
});
