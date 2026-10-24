import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { components } from '@taphoa/api-client';
import { describe, expect, it } from 'vitest';
import { getBackendUrl } from '../src/env.js';
import { createStore } from '../src/helpers.js';

type Point = components['schemas']['SegmentPointsRequest']['points'][number];
type Segmentation = components['schemas']['SegmentPointsResponse'];

// Generated once from shelf-1600.jpg with Pillow LANCZOS, JPEG quality 85.
// Matches the phone's 1024 px longest-side upload; no runtime resize dependency.
const photo = readFileSync(
  fileURLToPath(
    new URL(
      '../../../apps/backend/tests/fixtures/shelf-1024.jpg',
      import.meta.url,
    ),
  ),
);
const BUDGET_MS = Number(process.env.SEGMENT_POINTS_BUDGET_MS ?? 3000);
const RUNS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bottle body of the leftmost top product: (154, 280) in the 1600 px model fixture.
const foreground: Point = { x: 98.6, y: 179.2, label: 1 };
const background: Point = { x: 6.4, y: 6.4, label: 0 };

async function upload(token: string): Promise<string> {
  const form = new FormData();
  form.set(
    'image',
    new Blob([photo], { type: 'image/jpeg' }),
    'shelf-1024.jpg',
  );
  form.set('purpose', 'enrollment');
  const response = await fetch(`${getBackendUrl()}/v1/images`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const image = await response.json();
  expect(response.status, JSON.stringify(image)).toBe(201);
  expect(image.id).toMatch(UUID);
  expect(image.purpose).toBe('enrollment');
  return image.id;
}

async function segment(imageId: string, points: Point[], token?: string) {
  const response = await fetch(`${getBackendUrl()}/v1/segment/points`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ image_id: imageId, points }),
  });
  return { response, body: await response.json() };
}

async function segmentRetrying(
  imageId: string,
  points: Point[],
  token: string,
) {
  for (let attempt = 0; ; attempt++) {
    const result = await segment(imageId, points, token);
    const retryAfter = result.response.headers.get('retry-after');
    // Busy slots advertise Retry-After. Missing models do not; let the caller skip.
    if (result.response.status !== 503 || !retryAfter || attempt >= 5)
      return result;
    const seconds = Number(retryAfter);
    await new Promise((resolve) =>
      setTimeout(resolve, Number.isFinite(seconds) ? seconds * 1000 : 1000),
    );
  }
}

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

function p95(values: number[]): number {
  return [...values].sort((a, b) => a - b)[
    Math.ceil(0.95 * values.length) - 1
  ]!;
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

  it('segments five cold photos within budget and caches each second prompt', async (ctx) => {
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
    const latency = p95(runs.map((run) => run.upload_segment_ms));
    console.info(
      `segment points: ${RUNS} cold photos, p95=${latency.toFixed(1)} ms, budget=${BUDGET_MS} ms`,
    );
    expect(latency).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
