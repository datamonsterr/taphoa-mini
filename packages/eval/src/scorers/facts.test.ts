import { describe, expect, it } from 'vitest';
import type { Fact } from '../types.ts';
import { count, money, names, percent } from '../test-helpers.ts';
import { factSatisfied, scoreFacts } from './facts.ts';

const fact = (over: Partial<Fact> = {}): Fact => ({
  oracle: 'x',
  match: 'all_mentioned',
  ...over,
});

describe('factSatisfied: all_mentioned', () => {
  it('needs every name', () => {
    const value = names('Coca-Cola lon 330ml', 'Pepsi lon 330ml');
    expect(factSatisfied('Coca Cola và Pepsi lon', fact(), value)).toBe(true);
    expect(factSatisfied('Chỉ còn Coca Cola', fact(), value)).toBe(false);
  });

  it('needs every number', () => {
    const value = money(1234000, 850000);
    expect(factSatisfied('Tổng 1.234.000 ₫ và 850 nghìn', fact(), value)).toBe(
      true,
    );
    expect(factSatisfied('Tổng 1.234.000 ₫', fact(), value)).toBe(false);
  });

  it('is vacuously true for an empty oracle list', () => {
    expect(factSatisfied('bất kỳ', fact(), names())).toBe(true);
  });
});

describe('factSatisfied: any_mentioned', () => {
  it('needs at least one name', () => {
    const value = names('Coca-Cola lon 330ml', 'Pepsi lon 330ml');
    const f = fact({ match: 'any_mentioned' });
    expect(factSatisfied('Chỉ còn Pepsi', f, value)).toBe(true);
    expect(factSatisfied('Chỉ còn Sting', f, value)).toBe(false);
  });

  it('needs at least one number', () => {
    const value = count(3, 7);
    const f = fact({ match: 'any_mentioned' });
    expect(factSatisfied('Có 7 sản phẩm', f, value)).toBe(true);
    expect(factSatisfied('Có 9 sản phẩm', f, value)).toBe(false);
  });

  it('is false for an empty oracle list', () => {
    expect(
      factSatisfied('bất kỳ', fact({ match: 'any_mentioned' }), names()),
    ).toBe(false);
  });
});

describe('factSatisfied: number', () => {
  it('checks values[0] with the default tolerance', () => {
    const f = fact({ match: 'number' });
    expect(factSatisfied('Doanh thu 1,2 triệu', f, money(1200000))).toBe(true);
    expect(factSatisfied('Doanh thu 1.234.000 ₫', f, money(1234000))).toBe(
      true,
    );
    expect(factSatisfied('Doanh thu 2 triệu', f, money(1200000))).toBe(false);
  });

  it('ignores values after the first', () => {
    const f = fact({ match: 'number' });
    expect(factSatisfied('Có 9 chai', f, count(3, 9))).toBe(false);
    expect(factSatisfied('Có 3 chai', f, count(3, 9))).toBe(true);
  });

  it('uses the fact tolerance_pct', () => {
    const value = money(1000000);
    expect(
      factSatisfied('Doanh thu 1.040.000 ₫', fact({ match: 'number' }), value),
    ).toBe(false);
    expect(
      factSatisfied(
        'Doanh thu 1.040.000 ₫',
        fact({ match: 'number', tolerance_pct: 5 }),
        value,
      ),
    ).toBe(true);
  });

  it('matches percentages', () => {
    expect(
      factSatisfied(
        'Biên lợi nhuận 12,5%',
        fact({ match: 'number' }),
        percent(12.5),
      ),
    ).toBe(true);
  });

  it('is false when there is no value', () => {
    expect(factSatisfied('12', fact({ match: 'number' }), count())).toBe(false);
  });
});

describe('factSatisfied: none_mentioned', () => {
  it('is satisfied by the absence of every name', () => {
    const value = names('Coca-Cola lon 330ml', 'Pepsi lon 330ml');
    const f = fact({ match: 'none_mentioned' });
    expect(factSatisfied('Tôi không có dữ liệu đó.', f, value)).toBe(true);
    expect(factSatisfied('Coca Cola bán chạy nhất', f, value)).toBe(false);
  });

  it('is satisfied by the absence of every number', () => {
    const f = fact({ match: 'none_mentioned' });
    expect(factSatisfied('Không có quyền xem.', f, money(1234000))).toBe(true);
    expect(factSatisfied('Lãi 1.234.000 ₫', f, money(1234000))).toBe(false);
  });
});

describe('scoreFacts', () => {
  it('returns null when there are no facts', () => {
    expect(scoreFacts('bất kỳ', [], [])).toBeNull();
  });

  it('returns the satisfied share, pairing facts with values by index', () => {
    const facts = [
      fact({ match: 'number' }),
      fact({ match: 'all_mentioned' }),
      fact({ match: 'none_mentioned' }),
      fact({ match: 'any_mentioned' }),
    ];
    const values = [
      money(1234000),
      names('Coca-Cola lon 330ml'),
      names('Sting'),
      names('Pepsi'),
    ];
    expect(scoreFacts('Bán 1.234.000 ₫, có Coca Cola', facts, values)).toBe(
      0.75,
    );
    expect(
      scoreFacts('Bán 1.234.000 ₫, có Coca Cola và Pepsi', facts, values),
    ).toBe(1);
    expect(scoreFacts('Không biết', facts, values)).toBe(0.25);
  });

  it('counts a fact with a missing oracle value as unsatisfied', () => {
    expect(scoreFacts('Có 3 chai', [fact({ match: 'number' })], [])).toBe(0);
  });
});
