import { describe, expect, it } from 'vitest';
import type { GoldenCase, ProposedAction } from '../types.ts';
import { count, mkResolved, names } from '../test-helpers.ts';
import { actionOracleKey, scoreAction } from './action.ts';

type Expect = NonNullable<GoldenCase['expect_action']>;

const priceChange = (payload: Record<string, unknown>): ProposedAction => ({
  kind: 'price_change',
  payload,
});

describe('scoreAction: applicability and kind', () => {
  it('returns null when no action is expected', () => {
    expect(scoreAction([priceChange({})], null, mkResolved())).toBeNull();
    expect(scoreAction([], null, mkResolved())).toBeNull();
  });

  it('scores 0 when nothing was proposed', () => {
    expect(
      scoreAction([], { kind: 'price_change', fields: {} }, mkResolved()),
    ).toBe(0);
  });

  it('matches on kind alone when there are no field expectations', () => {
    const expected: Expect = { kind: 'price_change', fields: {} };
    expect(scoreAction([priceChange({ x: 1 })], expected, mkResolved())).toBe(
      1,
    );
    expect(
      scoreAction([{ kind: 'expense', payload: {} }], expected, mkResolved()),
    ).toBe(0);
  });

  it('passes when any proposed action matches', () => {
    const expected: Expect = {
      kind: 'price_change',
      fields: { new_price: { eq: 25000 } },
    };
    expect(
      scoreAction(
        [
          priceChange({ new_price: 30000 }),
          { kind: 'expense', payload: { new_price: 25000 } },
          priceChange({ new_price: 25000 }),
        ],
        expected,
        mkResolved(),
      ),
    ).toBe(1);
    expect(
      scoreAction(
        [priceChange({ new_price: 30000 }), priceChange({ new_price: 1 })],
        expected,
        mkResolved(),
      ),
    ).toBe(0);
  });
});

describe('scoreAction: ref', () => {
  const expected: Expect = {
    kind: 'stock_adjustment',
    fields: { product_id: { ref: 'product:Coca-Cola lon 330ml' } },
  };
  const resolved = mkResolved({
    refs: { 'product:Coca-Cola lon 330ml': 'p-123' },
  });

  it('compares with resolved.refs', () => {
    expect(
      scoreAction(
        [{ kind: 'stock_adjustment', payload: { product_id: 'p-123' } }],
        expected,
        resolved,
      ),
    ).toBe(1);
    expect(
      scoreAction(
        [{ kind: 'stock_adjustment', payload: { product_id: 'p-999' } }],
        expected,
        resolved,
      ),
    ).toBe(0);
  });

  it('fails when the ref was not resolved or the field is missing', () => {
    const payload = { product_id: 'p-123' };
    expect(
      scoreAction(
        [{ kind: 'stock_adjustment', payload }],
        expected,
        mkResolved(),
      ),
    ).toBe(0);
    expect(
      scoreAction(
        [{ kind: 'stock_adjustment', payload: {} }],
        expected,
        resolved,
      ),
    ).toBe(0);
  });
});

describe('scoreAction: eq', () => {
  const run = (value: unknown, eq: string | number | boolean) =>
    scoreAction(
      [priceChange({ v: value })],
      { kind: 'price_change', fields: { v: { eq } } },
      mkResolved(),
    );

  it('compares numbers numerically', () => {
    expect(run(25000, 25000)).toBe(1);
    expect(run('25000', 25000)).toBe(1);
    expect(run(25000, '25000')).toBe(1);
    expect(run(25000.0, 25000)).toBe(1);
    expect(run(25001, 25000)).toBe(0);
  });

  it('compares strings and booleans exactly', () => {
    expect(run('write-off', 'write-off')).toBe(1);
    expect(run('fix', 'write-off')).toBe(0);
    expect(run(true, true)).toBe(1);
    expect(run(false, true)).toBe(0);
    expect(run('true', true)).toBe(0);
  });

  it('deep-equals nested values with numeric comparison', () => {
    const expected = {
      kind: 'price_change',
      fields: { v: { eq: [1, { a: 2 }] as never } },
    };
    expect(
      scoreAction(
        [priceChange({ v: ['1', { a: 2 }] })],
        expected,
        mkResolved(),
      ),
    ).toBe(1);
    expect(
      scoreAction([priceChange({ v: [1, { a: 3 }] })], expected, mkResolved()),
    ).toBe(0);
  });
});

describe('scoreAction: min and max', () => {
  const run = (value: unknown, range: { min?: number; max?: number }) =>
    scoreAction(
      [priceChange({ v: value })],
      { kind: 'price_change', fields: { v: range } },
      mkResolved(),
    );

  it('checks an inclusive range', () => {
    expect(run(10, { min: 10, max: 20 })).toBe(1);
    expect(run(20, { min: 10, max: 20 })).toBe(1);
    expect(run(9, { min: 10, max: 20 })).toBe(0);
    expect(run(21, { min: 10, max: 20 })).toBe(0);
  });

  it('allows one open end and numeric strings', () => {
    expect(run(1000, { min: 10 })).toBe(1);
    expect(run(1000, { max: 10 })).toBe(0);
    expect(run('15', { min: 10, max: 20 })).toBe(1);
  });

  it('fails on non-numeric or missing values', () => {
    expect(run('abc', { min: 0 })).toBe(0);
    expect(run(null, { min: 0 })).toBe(0);
    expect(run(undefined, { min: 0 })).toBe(0);
  });
});

describe('scoreAction: oracle', () => {
  it('builds the key from the oracle name and the JSON of args', () => {
    expect(actionOracleKey('suggested_price', { product: 'Coca' })).toBe(
      'suggested_price{"product":"Coca"}',
    );
    expect(actionOracleKey('suggested_price')).toBe('suggested_price{}');
  });

  it('passes when the field equals any oracle value', () => {
    const expected: Expect = {
      kind: 'price_change',
      fields: {
        new_price: { oracle: 'suggested_price', args: { product: 'Coca' } },
      },
    };
    const resolved = mkResolved({
      actionOracles: {
        [actionOracleKey('suggested_price', { product: 'Coca' })]: {
          kind: 'money',
          values: [12000, 13000],
        },
      },
    });
    expect(
      scoreAction([priceChange({ new_price: 13000 })], expected, resolved),
    ).toBe(1);
    expect(
      scoreAction([priceChange({ new_price: '12000' })], expected, resolved),
    ).toBe(1);
    expect(
      scoreAction([priceChange({ new_price: 14000 })], expected, resolved),
    ).toBe(0);
  });

  it('compares names for a names oracle', () => {
    const expected: Expect = {
      kind: 'repayment',
      fields: { customer_id: { oracle: 'customer_ids' } },
    };
    const resolved = mkResolved({
      actionOracles: { [actionOracleKey('customer_ids')]: names('c-1', 'c-2') },
    });
    expect(
      scoreAction(
        [{ kind: 'repayment', payload: { customer_id: 'c-2' } }],
        expected,
        resolved,
      ),
    ).toBe(1);
    expect(
      scoreAction(
        [{ kind: 'repayment', payload: { customer_id: 'c-3' } }],
        expected,
        resolved,
      ),
    ).toBe(0);
  });

  it('fails when the oracle was not resolved', () => {
    const expected: Expect = {
      kind: 'price_change',
      fields: { new_price: { oracle: 'unknown' } },
    };
    expect(
      scoreAction([priceChange({ new_price: 1 })], expected, mkResolved()),
    ).toBe(0);
  });

  it('fails against an empty oracle value list', () => {
    const expected: Expect = {
      kind: 'price_change',
      fields: { new_price: { oracle: 'none' } },
    };
    const resolved = mkResolved({
      actionOracles: { [actionOracleKey('none')]: count() },
    });
    expect(
      scoreAction([priceChange({ new_price: 1 })], expected, resolved),
    ).toBe(0);
  });
});

describe('scoreAction: dotted paths', () => {
  it('walks nested objects', () => {
    const expected: Expect = {
      kind: 'expense',
      fields: {
        'detail.amount': { eq: 450000 },
        'detail.category': { eq: 'electricity' },
      },
    };
    const action: ProposedAction = {
      kind: 'expense',
      payload: { detail: { amount: 450000, category: 'electricity' } },
    };
    expect(scoreAction([action], expected, mkResolved())).toBe(1);
    expect(
      scoreAction(
        [{ kind: 'expense', payload: { detail: { amount: 1 } } }],
        expected,
        mkResolved(),
      ),
    ).toBe(0);
  });

  it('matches any element for a [] segment', () => {
    const expected: Expect = {
      kind: 'reorder_list',
      fields: {
        'items[].product_id': { ref: 'product:Pepsi' },
        'items[].quantity': { min: 10 },
      },
    };
    const resolved = mkResolved({ refs: { 'product:Pepsi': 'p-2' } });
    const action = (items: unknown): ProposedAction => ({
      kind: 'reorder_list',
      payload: { items },
    });
    expect(
      scoreAction(
        [
          action([
            { product_id: 'p-1', quantity: 2 },
            { product_id: 'p-2', quantity: 24 },
          ]),
        ],
        expected,
        resolved,
      ),
    ).toBe(1);
    expect(
      scoreAction(
        [action([{ product_id: 'p-1', quantity: 24 }])],
        expected,
        resolved,
      ),
    ).toBe(0);
    expect(scoreAction([action([])], expected, resolved)).toBe(0);
    expect(scoreAction([action('nope')], expected, resolved)).toBe(0);
  });

  it('fails when a segment is missing', () => {
    const expected: Expect = {
      kind: 'expense',
      fields: { 'detail.amount': { eq: 1 } },
    };
    expect(
      scoreAction(
        [{ kind: 'expense', payload: { detail: null } }],
        expected,
        mkResolved(),
      ),
    ).toBe(0);
    expect(
      scoreAction([{ kind: 'expense', payload: {} }], expected, mkResolved()),
    ).toBe(0);
  });

  it('requires every field expectation to hold', () => {
    const expected: Expect = {
      kind: 'expense',
      fields: { amount: { eq: 450000 }, category: { eq: 'electricity' } },
    };
    expect(
      scoreAction(
        [{ kind: 'expense', payload: { amount: 450000, category: 'rent' } }],
        expected,
        mkResolved(),
      ),
    ).toBe(0);
  });
});
