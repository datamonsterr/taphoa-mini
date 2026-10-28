import { randomUUID } from 'node:crypto';
import type { components } from '@taphoa/api-client';
import { describe, expect, it } from 'vitest';
import { createStore } from '../src/helpers.js';
import {
  foreground,
  background,
  upload,
  segment,
  segmentRetrying,
} from '../src/segment-points.js';

type Segmentation = components['schemas']['SegmentPointsResponse'];
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

  it('segments a cold photo and caches its second prompt', async (ctx) => {
    const store = await createStore();
    const token = store.session.access_token;
    const imageId = await upload(token);
    const cold = await segmentRetrying(imageId, [foreground], token);
    if (
      cold.response.status === 503 &&
      cold.body?.error === 'no model loaded'
    ) {
      ctx.skip('Backend has no segmentation model loaded (503).');
    }
    expect(cold.response.status, JSON.stringify(cold.body)).toBe(200);
    assertSegmentation(cold.body);
    expect(cold.body.timings.encode).toBeGreaterThan(0);
    const cached = await segmentRetrying(
      imageId,
      [foreground, background],
      token,
    );
    expect(cached.response.status, JSON.stringify(cached.body)).toBe(200);
    assertSegmentation(cached.body);
    expect(cached.body.timings.encode).toBe(0);
    // Timing budgets belong to recognition-latency.test.ts, the CI soft step.
  }, 120_000);
});
