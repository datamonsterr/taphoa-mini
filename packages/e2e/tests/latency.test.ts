import { describe, expect, it } from 'vitest';
import { createStore } from '../src/helpers.js';
import {
  decideLatency,
  latencySampleCount,
  percentile,
} from '../src/latency.js';

/**
 * Hot-endpoint latency (epic E5). Excludes recognition, which has its own budget in
 * recognition-latency.test.ts. Sequential requests after a warm-up; p95 over HOT_SAMPLES.
 * Subtract a per-endpoint /healthz median RTT to estimate backend processing time.
 */
const SAMPLES = latencySampleCount(process.env.HOT_SAMPLES, 30);
const BUDGET_MS = Number(process.env.HOT_P95_MS ?? 200);

// Refresh the baseline for each endpoint to follow changes in runner-to-edge RTT.
const BASELINE_SAMPLES = 5;

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
  it(`network-adjusted p95 < ${BUDGET_MS} ms over ${SAMPLES} requests per endpoint`, async () => {
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
      await warm.arrayBuffer();
      const baselineSamples: number[] = [];
      for (let i = 0; i < BASELINE_SAMPLES; i += 1) {
        const start = performance.now();
        const response = await fetch(base + '/healthz');
        await response.arrayBuffer();
        baselineSamples.push(performance.now() - start);
        expect(response.status, '/healthz baseline').toBe(200);
      }
      const samples: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const start = performance.now();
        const response = await fetch(base + path, { headers });
        await response.arrayBuffer();
        samples.push(performance.now() - start);
        expect(response.status, path).toBeLessThan(500);
      }
      const decision = decideLatency(samples, {
        budgetMs: BUDGET_MS,
        baselineMs: percentile(baselineSamples, 0.5),
      });
      const diagnostic = `${path} estimated-server p95=${Math.round(decision.adjustedMs)}ms client p95=${Math.round(decision.clientMs)}ms network baseline p50=${Math.round(decision.baselineMs)}ms budget=${BUDGET_MS}ms`;
      rows.push(diagnostic);
      if (!decision.passes) slow.push(diagnostic);
    }
    console.log(`hot endpoint latency (n=${SAMPLES}):\n${rows.join('\n')}`);
    expect(
      slow,
      `estimated server p95 must be < ${BUDGET_MS} ms after subtracting /healthz RTT`,
    ).toEqual([]);
  }, 240_000);
});
