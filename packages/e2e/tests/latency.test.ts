import { describe, expect, it } from 'vitest';
import { createStore } from '../src/helpers.js';

/**
 * Hot-endpoint latency (epic E5). Excludes recognition, which has its own budget in
 * recognition.test.ts. Sequential requests after a warm-up; p95 over HOT_SAMPLES.
 * The budget applies to the deployed backend as seen from the test runner.
 */
const SAMPLES = Number(process.env.HOT_SAMPLES ?? 30);
const BUDGET_MS = Number(process.env.HOT_P95_MS ?? 200);

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
  ];
}

const endpoints = [
  '/v1/me',
  '/v1/store',
  '/v1/members',
  '/v1/products',
  '/v1/categories',
  '/v1/reports/today',
  '/v1/alerts',
  '/v1/sync/changes',
] as const;

describe('hot endpoint latency', () => {
  it(`p95 < ${BUDGET_MS} ms over ${SAMPLES} requests per endpoint`, async () => {
    const { session } = await createStore();
    const base = (process.env.BACKEND_URL ?? 'http://localhost:8080').replace(
      /\/$/,
      '',
    );
    const headers = { authorization: `Bearer ${session.access_token}` };
    const rows: string[] = [];
    const slow: string[] = [];
    for (const path of endpoints) {
      const warm = await fetch(base + path, { headers });
      expect(warm.status, `${path} warm-up`).toBeLessThan(500);
      const samples: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const start = performance.now();
        const response = await fetch(base + path, { headers });
        await response.arrayBuffer();
        samples.push(performance.now() - start);
        expect(response.status, path).toBeLessThan(500);
      }
      const value = p95(samples);
      rows.push(`${path} p95=${Math.round(value)}ms`);
      if (value >= BUDGET_MS) slow.push(`${path} ${Math.round(value)}ms`);
    }
    console.log(`hot endpoint latency (n=${SAMPLES}):\n${rows.join('\n')}`);
    expect(slow, `endpoints over ${BUDGET_MS} ms`).toEqual([]);
  }, 120_000);
});
