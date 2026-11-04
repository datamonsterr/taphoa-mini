import { describe, expect, it } from 'vitest';
import { decideLatency, latencySampleCount, percentile } from './latency.js';

describe('latency decisions', () => {
  it('ignores one slow recognition sample out of twelve at p90', () => {
    const samples = [...Array<number>(11).fill(2500), 30_000];
    expect(
      decideLatency(samples, { budgetMs: 3000, quantile: 0.9 }),
    ).toMatchObject({
      passes: true,
      adjustedMs: 2500,
    });
    // p95 of twelve still selects the maximum; use p90 intentionally.
    expect(percentile(samples, 0.95)).toBe(30_000);
  });

  it('rejects a sustained recognition regression', () => {
    const samples = [2000, ...Array<number>(11).fill(3100)];
    expect(
      decideLatency(samples, { budgetMs: 3000, quantile: 0.9 }).passes,
    ).toBe(false);
  });

  it('accepts high network RTT with low estimated server time', () => {
    const baselineMs = percentile([500, 510, 520, 530, 2000], 0.5);
    expect(
      decideLatency(Array<number>(30).fill(545), { budgetMs: 200, baselineMs }),
    ).toMatchObject({
      passes: true,
      clientMs: 545,
      baselineMs: 520,
      adjustedMs: 25,
    });
  });

  it('rejects sustained hot-endpoint regression after subtracting network RTT', () => {
    expect(
      decideLatency(Array<number>(30).fill(750), {
        budgetMs: 200,
        baselineMs: 520,
      }),
    ).toMatchObject({ passes: false, adjustedMs: 230 });
  });

  it('ignores one hot-endpoint outlier out of thirty at p95', () => {
    expect(
      decideLatency([...Array<number>(29).fill(100), 2000], { budgetMs: 200 })
        .passes,
    ).toBe(true);
  });

  it('enforces a strict budget and clamps negative estimates to zero', () => {
    expect(decideLatency([200], { budgetMs: 200 }).passes).toBe(false);
    expect(
      decideLatency([10], { budgetMs: 200, baselineMs: 20 }).adjustedMs,
    ).toBe(0);
  });
});

describe('percentile', () => {
  it('uses nearest rank and leaves input order intact', () => {
    const samples = [40, 10, 30, 20];
    expect(percentile(samples, 0.5)).toBe(20);
    expect(percentile(samples, 0)).toBe(10);
    expect(percentile(samples, 1)).toBe(40);
    expect(samples).toEqual([40, 10, 30, 20]);
  });

  it('rejects invalid samples, quantiles and decision options', () => {
    for (const samples of [[], [NaN], [Infinity], [-1]]) {
      expect(() => percentile(samples, 0.95)).toThrow(RangeError);
    }
    for (const quantile of [-0.1, 1.1, NaN]) {
      expect(() => percentile([1], quantile)).toThrow(RangeError);
    }
    for (const budgetMs of [0, -1, Infinity, NaN]) {
      expect(() => decideLatency([1], { budgetMs })).toThrow(RangeError);
    }
    for (const baselineMs of [-1, Infinity, NaN]) {
      expect(() => decideLatency([1], { budgetMs: 200, baselineMs })).toThrow(
        RangeError,
      );
    }
  });
});

describe('latencySampleCount', () => {
  it('supports defaults and environment overrides', () => {
    expect(latencySampleCount(undefined, 12)).toBe(12);
    expect(latencySampleCount('24', 12)).toBe(24);
  });

  it('rejects invalid overrides', () => {
    for (const value of ['0', '-1', '1.5', '', 'NaN', 'Infinity']) {
      expect(() => latencySampleCount(value, 12)).toThrow(RangeError);
    }
  });
});
