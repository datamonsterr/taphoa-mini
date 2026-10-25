import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  calibrate,
  loadCalibrationItems,
  renderCalibration,
  type CalibrationItem,
} from './calibrate.ts';
import type { JudgeResult } from './judge.ts';

const item = (
  human_score: number,
  answer = `a${human_score}`,
): CalibrationItem => ({
  rubric_vi: 'rubric',
  answer,
  human_score,
});

/** A judge that returns a fixed score per answer text. */
function judgeWith(scores: Record<string, number | null>) {
  return async ({ answer }: { rubric_vi: string; answer: string }) => {
    const score = scores[answer];
    if (score === undefined || score === null) return null;
    return { score, reason: 'r', model: 'judge/x' } satisfies JudgeResult;
  };
}

describe('calibrate', () => {
  it('computes agreement and mean absolute error', async () => {
    const items = [item(5, 'a'), item(4, 'b'), item(2, 'c'), item(1, 'd')];
    const result = await calibrate(
      items,
      judgeWith({ a: 5, b: 3, c: 2, d: 4 }),
    );
    // agree: a (both pass), c (both fail); disagree: b (4 vs 3), d (1 vs 4)
    expect(result.agreement).toBeCloseTo(0.5);
    expect(result.mae).toBeCloseTo((0 + 1 + 0 + 3) / 4);
    expect(result.pass).toBe(false);
    expect(result.rows).toHaveLength(4);
    expect(result.rows[1]).toMatchObject({
      human: 4,
      judge: 3,
      error: 1,
      agree: false,
    });
  });

  it('passes at exactly 90 % agreement and MAE 0.8', async () => {
    // 7 agreeing items off by 1... 9 agree, 1 disagrees; total error 8 -> MAE 0.8
    const items = [
      ...Array.from({ length: 7 }, (_, i) => item(5, `hi${i}`)),
      item(1, 'lo1'),
      item(1, 'lo2'),
      item(4, 'edge'),
    ];
    const scores: Record<string, number> = { lo1: 1, lo2: 1, edge: 3 };
    for (let i = 0; i < 7; i++) scores[`hi${i}`] = 4;
    const result = await calibrate(items, judgeWith(scores));
    expect(result.agreement).toBeCloseTo(0.9);
    expect(result.mae).toBeCloseTo(0.8);
    expect(result.pass).toBe(true);
  });

  it('fails when agreement is high but MAE is above 0.8', async () => {
    // all agree on the side of 4, but each is off by 2 or 3
    const items = [item(5, 'a'), item(5, 'b')];
    const result = await calibrate(items, judgeWith({ a: 4, b: 4 }));
    expect(result.agreement).toBe(1);
    expect(result.mae).toBe(1);
    expect(result.pass).toBe(false);
  });

  it('counts an unjudged item as a disagreement and never passes', async () => {
    const items = Array.from({ length: 10 }, (_, i) => item(5, `x${i}`));
    const scores: Record<string, number | null> = {};
    for (let i = 0; i < 10; i++) scores[`x${i}`] = i === 0 ? null : 5;
    const result = await calibrate(items, judgeWith(scores));
    expect(result.agreement).toBeCloseTo(0.9);
    expect(result.mae).toBe(0);
    expect(result.rows[0]).toMatchObject({ judge: null, agree: false });
    expect(result.pass).toBe(false);
  });

  it('does not pass with no items', async () => {
    const result = await calibrate([], judgeWith({}));
    expect(result).toMatchObject({
      agreement: 0,
      mae: 0,
      pass: false,
      rows: [],
    });
  });
});

describe('loadCalibrationItems', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'calibration-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the shipped fixture', () => {
    const fixture = fileURLToPath(
      new URL('./calibration.fixture.jsonl', import.meta.url),
    );
    const items = loadCalibrationItems(fixture);
    expect(items).toHaveLength(3);
    for (const it of items) {
      expect(it.human_score).toBeGreaterThanOrEqual(1);
      expect(it.human_score).toBeLessThanOrEqual(5);
    }
  });

  it('reports the file and line of a bad item', () => {
    const file = join(dir, 'c.jsonl');
    writeFileSync(
      file,
      '{"rubric_vi":"r","answer":"a","human_score":4}\n{"rubric_vi":"r","answer":"a","human_score":9}\n',
    );
    expect(() => loadCalibrationItems(file)).toThrow(`${file}:2`);
  });

  it('names the missing file', () => {
    expect(() => loadCalibrationItems(join(dir, 'none.jsonl'))).toThrow(
      'none.jsonl',
    );
  });
});

describe('renderCalibration', () => {
  it('renders the verdict, the figures and one row per item', async () => {
    const items = [item(5, 'a'), item(1, 'b')];
    const result = await calibrate(items, judgeWith({ a: 5, b: 2 }));
    const md = renderCalibration(result, {
      judgeModel: 'judge/x',
      date: '2026-10-25',
    });
    expect(md).toContain('# Judge calibration');
    expect(md).toContain('judge/x');
    expect(md).toContain('2026-10-25');
    expect(md).toContain('Agreement: 100 %');
    expect(md).toContain('MAE: 0.5');
    expect(md).toContain('Verdict: PASS');
    expect(md.match(/^\| \d+ \|/gm)).toHaveLength(2);
    expect(
      renderCalibration(result, { judgeModel: 'judge/x', date: '2026-10-25' }),
    ).toBe(md);
  });

  it('shows FAIL when the thresholds are missed', async () => {
    const result = await calibrate([item(5, 'a')], judgeWith({ a: 1 }));
    const md = renderCalibration(result, {
      judgeModel: 'j',
      date: '2026-10-25',
    });
    expect(md).toContain('Verdict: FAIL');
  });
});

describe('fixture file', () => {
  it('has 3 placeholder items', () => {
    const lines = readFileSync(
      fileURLToPath(new URL('./calibration.fixture.jsonl', import.meta.url)),
      'utf8',
    )
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(3);
  });
});
