import { describe, expect, it } from 'vitest';
import type { GoldenCase, UseCase } from '../types.ts';
import { mkFullSet as fullSet } from '../test-helpers.ts';
import { checkCoverage } from './coverage.ts';

const without = (cases: GoldenCase[], ...ids: string[]) =>
  cases.filter((c) => !ids.includes(c.id));

describe('checkCoverage: counts', () => {
  it('accepts a set that meets every rule', () => {
    const cases = fullSet();
    expect(cases).toHaveLength(144);
    expect(checkCoverage(cases)).toEqual([]);
  });

  it('reports every missing category for an empty set', () => {
    const problems = checkCoverage([]).join('\n');
    for (let u = 1; u <= 23; u++) expect(problems).toContain(`U${u}:`);
    for (const word of [
      'OT',
      'permission',
      'injection',
      'ambiguity',
      'smoke',
    ]) {
      expect(problems).toContain(word);
    }
    expect(checkCoverage([]).length).toBe(23 + 1 + 3 + 2);
  });

  it('flags a use case with fewer than 6 cases', () => {
    const problems = checkCoverage(without(fullSet(), 'U7-06'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('U7');
    expect(problems[0]).toContain('5');
  });

  it('counts pending cases toward a use case', () => {
    const cases = fullSet().map((c) =>
      c.use_case === 'U23'
        ? { ...c, pending: { on: 'X5' as const, reason: 'debt tools' } }
        : c,
    );
    expect(checkCoverage(cases)).toEqual([]);
  });

  it('flags tag counts below the minimum', () => {
    const base = fullSet();
    // U3-03, U4-03 permission cases become plain cases.
    const permission = base.map((c) =>
      c.id === 'U3-03' ? { ...c, tags: [] } : c,
    );
    expect(checkCoverage(permission)).toEqual([
      expect.stringContaining('permission'),
    ]);

    const injection = base.map((c) =>
      c.id === 'U11-03' ? { ...c, tags: [] } : c,
    );
    expect(checkCoverage(injection)).toEqual([
      expect.stringContaining('injection'),
    ]);

    const ambiguity = base.map((c) =>
      c.id === 'U1-04' ? { ...c, tags: [] } : c,
    );
    expect(checkCoverage(ambiguity)).toEqual([
      expect.stringContaining('ambiguity'),
    ]);
  });

  it('flags fewer than 6 OT cases', () => {
    const problems = checkCoverage(without(fullSet(), 'OT-06'));
    expect(problems).toEqual([expect.stringContaining('OT')]);
  });

  it('does not count OT cases by tag', () => {
    const cases = fullSet().map((c) =>
      c.id === 'OT-06' ? { ...c, use_case: 'U1' as UseCase, id: 'U1-07' } : c,
    );
    expect(checkCoverage(cases)).toEqual([expect.stringContaining('OT')]);
  });
});

describe('checkCoverage: smoke set', () => {
  it('requires exactly 25 smoke cases', () => {
    const base = fullSet();
    const fewer = base.map((c) => (c.id === 'U10-02' ? { ...c, tags: [] } : c));
    expect(checkCoverage(fewer)).toEqual([expect.stringContaining('smoke')]);
    expect(checkCoverage(fewer)[0]).toContain('24');

    const more = base.map((c) =>
      c.id === 'U16-02' ? { ...c, tags: ['smoke'] } : c,
    );
    expect(checkCoverage(more)).toEqual([expect.stringContaining('smoke')]);
    expect(checkCoverage(more)[0]).toContain('26');
  });

  it('requires smoke cases in at least 15 use cases', () => {
    // Move U15's only smoke case onto U1: still 25 cases, but 14 use cases.
    const cases = fullSet().map((c) => {
      if (c.id === 'U15-01') return { ...c, tags: [] };
      if (c.id === 'U1-05') return { ...c, tags: ['smoke'] };
      return c;
    });
    const problems = checkCoverage(cases);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('15');
    expect(problems[0]).toContain('14');
  });

  it('accepts exactly 15 use cases', () => {
    expect(checkCoverage(fullSet())).toEqual([]);
  });
});

describe('checkCoverage: oracle names', () => {
  const known = new Set(['known_a', 'known_b', 'margin_pct']);

  const withOracles = (c: Partial<GoldenCase>) =>
    fullSet().map((x) => (x.id === 'U1-05' ? { ...x, ...c } : x));

  it('skips the check when knownOracles is not given', () => {
    const cases = withOracles({
      expect_facts: [{ oracle: 'whatever', match: 'number' }],
    });
    expect(checkCoverage(cases)).toEqual([]);
  });

  it('accepts known names everywhere', () => {
    const cases = withOracles({
      expect_facts: [{ oracle: 'known_a', match: 'number' }],
      denied_facts: [{ oracle: 'known_b', match: 'none_mentioned' }],
      expect_action: {
        kind: 'price_change',
        fields: { new_price: { oracle: 'known_a' } },
      },
    });
    expect(checkCoverage(cases, known)).toEqual([]);
  });

  it('flags unknown names in expect_facts, denied_facts and expect_action', () => {
    const cases = withOracles({
      expect_facts: [{ oracle: 'missing_facts', match: 'number' }],
      denied_facts: [{ oracle: 'missing_denied', match: 'none_mentioned' }],
      expect_action: {
        kind: 'price_change',
        fields: {
          new_price: { oracle: 'missing_action' },
          product_id: { ref: 'product:Coca' },
          qty: { min: 1 },
        },
      },
    });
    const problems = checkCoverage(cases, known);
    expect(problems).toHaveLength(3);
    const text = problems.join('\n');
    for (const name of ['missing_facts', 'missing_denied', 'missing_action']) {
      expect(text).toContain(name);
    }
    expect(text).toContain('U1-05');
  });

  it('skips the oracle-name check for pending cases', () => {
    const pending = { on: 'X5' as const, reason: 'debt tools' };
    const cases = fullSet().map((x) =>
      x.id === 'U23-03'
        ? {
            ...x,
            pending,
            expect_facts: [{ oracle: 'debt_total', match: 'number' as const }],
            denied_facts: [
              {
                oracle: 'denied_debt_totals',
                match: 'none_mentioned' as const,
              },
            ],
          }
        : x,
    );
    expect(checkCoverage(cases, known)).toEqual([]);
    const live = cases.map((x) =>
      x.id === 'U23-03' ? { ...x, pending: undefined } : x,
    );
    expect(checkCoverage(live, known).join('\n')).toContain('debt_total');
  });

  it('reports each unknown oracle once with the cases that use it', () => {
    const cases = fullSet().map((x) =>
      x.id === 'U1-05' || x.id === 'U2-05'
        ? {
            ...x,
            expect_facts: [{ oracle: 'missing', match: 'number' as const }],
          }
        : x,
    );
    const problems = checkCoverage(cases, known);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('missing');
    expect(problems[0]).toContain('U1-05');
    expect(problems[0]).toContain('U2-05');
  });
});
