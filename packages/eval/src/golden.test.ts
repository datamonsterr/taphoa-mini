import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCoverage } from './cases/coverage.ts';
import { loadGolden } from './cases/load.ts';
import { loadCalibrationItems } from './judge/calibrate.ts';
import { ORACLE_NAMES } from './oracle/catalog.ts';
import type { GoldenCase } from './types.ts';

const dir = fileURLToPath(new URL('../golden', import.meta.url));
const { cases, errors } = loadGolden(dir);

const by = (tag: string) => cases.filter((c) => c.tags.includes(tag));
const live = (list: GoldenCase[]) => list.filter((c) => !c.pending);

describe('the golden set', () => {
  it('loads with no errors', () => {
    expect(errors).toEqual([]);
  });

  it('meets every coverage rule and uses known oracles', () => {
    expect(checkCoverage(cases, ORACLE_NAMES)).toEqual([]);
  });

  it('holds 144 cases: 6 per use case and 6 off-topic', () => {
    expect(cases).toHaveLength(144);
    const per = new Map<string, number>();
    for (const c of cases) per.set(c.use_case, (per.get(c.use_case) ?? 0) + 1);
    expect([...per.values()].every((n) => n === 6)).toBe(true);
    expect(per.size).toBe(24);
  });

  it('keeps message text unique per role (the stub finds a case by it)', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const c of cases) {
      const first = c.messages[0]?.content;
      if (first === undefined) continue;
      const key = `${c.role}\u0000${first}`;
      const other = seen.get(key);
      if (other) dup.push(`${c.id} repeats ${other}`);
      else seen.set(key, c.id);
    }
    expect(dup).toEqual([]);
  });

  it('applies the planned distribution of tags and kinds', () => {
    expect(by('permission')).toHaveLength(10);
    expect(live(by('permission')).length).toBeGreaterThanOrEqual(8);
    expect(by('injection')).toHaveLength(8);
    expect(live(by('injection')).length).toBeGreaterThanOrEqual(6);
    expect(by('ambiguity')).toHaveLength(6);
    expect(by('offtopic')).toHaveLength(6);
    expect(by('voice')).toHaveLength(6);
    expect(by('voice').every((c) => c.use_case === 'U15')).toBe(true);
    expect(by('multi_turn').length).toBeGreaterThanOrEqual(7);
    expect(
      cases.filter((c) => c.language === 'en').length,
    ).toBeGreaterThanOrEqual(2);

    const digests = cases.filter(
      (c) => c.use_case === 'U13' && c.kind === 'digest',
    );
    expect(digests).toHaveLength(4);
    expect(digests.every((c) => c.pending?.on === 'X8')).toBe(true);
    const u23 = cases.filter((c) => c.use_case === 'U23');
    expect(u23.every((c) => c.pending?.on === 'X5')).toBe(true);
  });

  it('keeps the smoke set live and balanced', () => {
    const smoke = by('smoke');
    expect(smoke).toHaveLength(25);
    expect(smoke.every((c) => !c.pending)).toBe(true);
    const n = (pred: (c: GoldenCase) => boolean) => smoke.filter(pred).length;
    expect(n((c) => c.tags.includes('permission'))).toBe(2);
    expect(n((c) => c.tags.includes('injection'))).toBe(2);
    expect(n((c) => c.tags.includes('ambiguity'))).toBe(1);
    expect(n((c) => c.tags.includes('offtopic'))).toBe(1);
    expect(n((c) => c.tags.includes('multi_turn'))).toBe(1);
    expect(n((c) => c.expect_action !== null)).toBeGreaterThanOrEqual(2);
  });

  it('spreads permission cases over the planned use cases', () => {
    const used = new Set(by('permission').map((c) => c.use_case));
    for (const u of ['U2', 'U3', 'U5', 'U8', 'U17', 'U22', 'U23']) {
      expect(used.has(u as GoldenCase['use_case']), u).toBe(true);
    }
  });

  it('uses the exact canary strings in injection cases', () => {
    const canaries = cases.flatMap((c) => c.injection?.canaries ?? []);
    expect(canaries.length).toBeGreaterThan(0);
    for (const k of canaries) {
      // The note canary belongs to the pending U23 case until X5 seeds it.
      expect([
        'CANARY-PRODUCT-7731',
        'CANARY-OCR-4482',
        'CANARY-NOTE-5519',
      ]).toContain(k);
      if (k === 'CANARY-NOTE-5519') {
        expect(
          cases
            .filter((c) => c.injection?.canaries.includes(k))
            .every((c) => c.pending),
        ).toBe(true);
      }
    }
  });

  it('gives every live case something to score', () => {
    for (const c of live(cases).filter((x) => x.kind !== 'digest')) {
      const scored =
        c.expect_tools.must.length > 0 ||
        (c.expect_tools.any_of ?? []).length > 0 ||
        c.expect_facts.length > 0 ||
        c.expect_action !== null ||
        c.expect_tools.must_not.length > 0 ||
        c.tags.includes('offtopic') ||
        c.tags.includes('ambiguity') ||
        (c.denied_facts ?? []).length > 0;
      expect(scored, c.id).toBe(true);
    }
  });
});

describe('the judge calibration set', () => {
  const file = fileURLToPath(
    new URL('./judge/calibration.jsonl', import.meta.url),
  );
  const items = loadCalibrationItems(file);

  it('holds 10 items with the planned score spread', () => {
    expect(items).toHaveLength(10);
    const spread = [1, 2, 3, 4, 5].map(
      (s) => items.filter((i) => i.human_score === s).length,
    );
    expect(spread).toEqual([1, 2, 2, 2, 3]);
  });

  it('uses rubrics copied from golden cases', () => {
    const rubrics = new Set(cases.map((c) => c.rubric_vi));
    for (const item of items) expect(rubrics.has(item.rubric_vi)).toBe(true);
  });

  it('has a different answer for every item', () => {
    expect(new Set(items.map((i) => i.answer)).size).toBe(items.length);
  });
});
