import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { components } from '@taphoa/api-client';
import { expect } from 'vitest';
import { getBackendUrl } from './env.js';

export type Point =
  components['schemas']['SegmentPointsRequest']['points'][number];

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bottle body of the leftmost top product: (154, 280) in the 1600 px model fixture.
export const foreground: Point = { x: 98.6, y: 179.2, label: 1 };
export const background: Point = { x: 6.4, y: 6.4, label: 0 };

export async function upload(token: string): Promise<string> {
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

export async function segment(
  imageId: string,
  points: Point[],
  token?: string,
) {
  const started = performance.now();
  const response = await fetch(`${getBackendUrl()}/v1/segment/points`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ image_id: imageId, points }),
  });
  const body = await response.json();
  return { response, body, ms: performance.now() - started };
}

export async function segmentRetrying(
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
