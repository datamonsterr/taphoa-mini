import { randomUUID } from 'node:crypto';
import type { components } from '@taphoa/api-client';
import { describe, expect, it } from 'vitest';
import { createStore } from '../src/helpers.js';
import { decideLatency, latencySampleCount } from '../src/latency.js';
import {
  foreground,
  background,
  upload,
  segment,
  segmentRetrying,
} from '../src/segment-points.js';

type Segmentation = components['schemas']['SegmentPointsResponse'];
const BUDGET_MS = Number(process.env.SEGMENT_POINTS_BUDGET_MS ?? 3000);
const RUNS = latencySampleCount(process.env.SEGMENT_POINTS_RUNS, 12);
// Upload, cold and cached prompts, and busy retries have a timeout independent of the budget.
const TEST_TIMEOUT_MS = RUNS * 20_000 + 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSegmentation(body: Segmentation) {
  expect(body.bbox).toHaveLength(4);
  for (const value of body.bbox) expect(Number.isFinite(value)).toBe(true);
  expect(body.score).toBeGreaterThan(0);
  expect(body.area).toBeGreaterThan(0);
  expect(body.mask.width).toBeGreaterThan(0);
  expect(body.mask.height).toBeGreaterThan(0);
  expect(body.mask.png_base64.length).toBeGreaterThan(0);
  expect(Buffer.from(body.mask.png_base64, 'base64').subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(body.cutout_image_id).toMatch(UUID);
  for (const key of ['encode', 'decode', 'total'] as const) {
    expect(Number.isInteger(body.timings[key])).toBe(true);
    expect(body.timings[key]).toBeGreaterThanOrEqual(0);
  }
}

describe('point-prompted segmentation', () => {
  it('requires authentication', async () => {
    const result = await segment(randomUUID(), [foreground]);
    expect(result.response.status).toBe(401);
  });

  it('rejects three points', async () => {
    const store = await createStore();
    const result = await segment(
      randomUUID(),
      [foreground, background, foreground],
      store.session.access_token,
    );
    expect(result.response.status).toBe(422);
  });

  it(
    'segments cold photos within budget and caches each second prompt',
    async (ctx) => {
      expect(Number.isFinite(BUDGET_MS) && BUDGET_MS > 0).toBe(true);
      const store = await createStore();
      const token = store.session.access_token;
      const imageIds = new Set<string>();
      const runs = [];
      for (let run = 1; run <= RUNS; run++) {
        // Includes upload, response bodies, segmentation, and any busy-slot retry waits.
        // Each new image ID forces the real per-photo encoder cost, even for identical bytes.
        const started = performance.now();
        const imageId = await upload(token);
        const uploaded = performance.now();
        expect(imageIds.has(imageId)).toBe(false);
        imageIds.add(imageId);
        const cold = await segmentRetrying(imageId, [foreground], token);
        const coldMs = performance.now() - started;
        if (
          cold.response.status === 503 &&
          cold.body?.error === 'no model loaded'
        ) {
          const reason =
            'Skipping segment points latency: backend has no segmentation model loaded (503).';
          console.warn(reason);
          ctx.skip(reason);
        }
        expect(cold.response.status, JSON.stringify(cold.body)).toBe(200);
        assertSegmentation(cold.body);
        expect(cold.body.timings.encode).toBeGreaterThan(0);

        const cachedStarted = performance.now();
        const cached = await segmentRetrying(
          imageId,
          [foreground, background],
          token,
        );
        const cachedMs = performance.now() - cachedStarted;
        expect(cached.response.status, JSON.stringify(cached.body)).toBe(200);
        assertSegmentation(cached.body);
        expect(cached.body.timings.encode).toBe(0);
        runs.push({
          run,
          upload_ms: uploaded - started,
          upload_segment_ms: coldMs,
          encode_ms: cold.body.timings.encode,
          decode_ms: cold.body.timings.decode,
          server_total_ms: cold.body.timings.total,
          cached_ms: cachedMs,
          cached_encode_ms: cached.body.timings.encode,
          cached_decode_ms: cached.body.timings.decode,
          cached_server_total_ms: cached.body.timings.total,
        });
      }
      console.table(runs);
      const samples = runs.map((run) => run.upload_segment_ms);
      const decision = decideLatency(samples, {
        budgetMs: BUDGET_MS,
        quantile: 0.9,
      });
      console.info(
        `segment points: ${RUNS} cold photos, upload_segment_ms=[${samples.map((ms) => ms.toFixed(1)).join(', ')}], p90=${decision.adjustedMs.toFixed(1)} ms, budget=${BUDGET_MS} ms`,
      );
      expect(
        decision.passes,
        `point segmentation upload+segment p90 ${decision.adjustedMs}ms must be < ${BUDGET_MS}ms`,
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
