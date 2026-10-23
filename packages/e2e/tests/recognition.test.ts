import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getBackendUrl } from '../src/env.js';
import { createStore } from '../src/helpers.js';

// 1600x1200 JPEG with 18 products, shared with the backend model tests.
const photo = readFileSync(
  fileURLToPath(
    new URL(
      '../../../apps/backend/tests/fixtures/shelf-1600.jpg',
      import.meta.url,
    ),
  ),
);

const LATENCY_BUDGET_MS = Number(process.env.RECOGNITION_BUDGET_MS ?? 3000);
const RUNS = 5;

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set('image', new Blob([photo], { type: 'image/jpeg' }), 'shelf.jpg');
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function post(
  path: string,
  body: FormData,
  token?: string,
): Promise<{ status: number; json: any; ms: number; headers: Headers }> {
  // Buffer the multipart body: streaming it races the server's early 401 (EPIPE).
  const request = new Request(`${getBackendUrl()}${path}`, {
    method: 'POST',
    body,
  });
  const payload = await request.arrayBuffer();
  const started = performance.now();
  const response = await fetch(request.url, {
    method: 'POST',
    body: payload,
    headers: {
      'content-type': request.headers.get('content-type') ?? '',
      'x-forwarded-for': `10.${Math.floor(Math.random() * 256)}.1.${Math.floor(Math.random() * 256)}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const json = await response.json().catch(() => null);
  return {
    status: response.status,
    json,
    ms: performance.now() - started,
    headers: response.headers,
  };
}

/** The single inference slot answers 503 + Retry-After while busy; retry like the phone does. */
async function postRetrying(path: string, make: () => FormData, token: string) {
  for (let attempt = 0; ; attempt++) {
    const result = await post(path, make(), token);
    if (result.status !== 503 || attempt >= 5) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
  ]!;
}

describe('recognition', () => {
  it('requires auth for scans', async () => {
    const result = await post('/v1/recognition/scans', form());
    expect(result.status).toBe(401);
  });

  it('creates a multi scan within the latency budget and reads it back', async () => {
    const store = await createStore();
    const token = store.session.access_token;
    const samples: number[] = [];
    let last: any;
    for (let run = 0; run < RUNS; run++) {
      // Not counted: a busy slot is a retry, only the successful request is timed.
      const result = await postRetrying(
        '/v1/recognition/scans',
        () => form({ mode: 'multi' }),
        token,
      );
      expect(result.status).toBe(201);
      samples.push(result.ms);
      last = result.json;
    }
    console.info(
      `scan latency ms: ${samples.map((s) => Math.round(s)).join(', ')} p95=${Math.round(p95(samples))}`,
    );
    expect(p95(samples)).toBeLessThan(LATENCY_BUDGET_MS);

    expect(last.mode).toBe('multi');
    expect(last.purpose).toBe('checkout');
    expect(last.pipeline.segmenter).toBeTruthy();
    expect(last.pipeline.embedder).toBeTruthy();
    expect(last.detections.length).toBeGreaterThanOrEqual(5);
    // Empty catalog: nothing can match.
    for (const detection of last.detections) {
      expect(detection.match).toBe('unknown');
      expect(detection.candidates).toEqual([]);
      expect(detection.bbox).toHaveLength(4);
    }
    for (const key of ['segment', 'embed', 'search', 'total']) {
      expect(typeof last.timings_ms[key]).toBe('number');
    }

    const fetched = await store.client.raw.GET(
      '/v1/recognition/scans/{scanId}',
      {
        params: { path: { scanId: last.id } },
      },
    );
    expect(fetched.response.status).toBe(200);
    expect(fetched.data?.id).toBe(last.id);
    expect(fetched.data?.detections.length).toBe(last.detections.length);
  });

  it('hides scans from other stores', async () => {
    const owner = await createStore();
    const stranger = await createStore();
    const scan = await postRetrying(
      '/v1/recognition/scans',
      () => form({ mode: 'single' }),
      owner.session.access_token,
    );
    expect(scan.status).toBe(201);
    expect(scan.json.detections.length).toBe(1);
    const response = await stranger.client.raw.GET(
      '/v1/recognition/scans/{scanId}',
      {
        params: { path: { scanId: scan.json.id } },
      },
    );
    expect(response.response.status).toBe(404);
  });

  it('rejects malformed scan requests', async () => {
    const store = await createStore();
    const token = store.session.access_token;
    const noImage = new FormData();
    noImage.set('mode', 'multi');
    expect((await post('/v1/recognition/scans', noImage, token)).status).toBe(
      400,
    );
    const badMode = await postRetrying(
      '/v1/recognition/scans',
      () => form({ mode: 'everything' }),
      token,
    );
    expect(badMode.status).toBe(400);
    const notImage = new FormData();
    notImage.set('image', new Blob(['not an image']), 'x.jpg');
    expect((await post('/v1/recognition/scans', notImage, token)).status).toBe(
      415,
    );
  });

  it('segments a 1600 px photo within the latency budget', async () => {
    const samples: number[] = [];
    let segments: any[] = [];
    for (let run = 0; run < RUNS; run++) {
      let result = await post('/v1/segment', form());
      for (let attempt = 0; result.status === 503 && attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        result = await post('/v1/segment', form());
      }
      expect(result.status).toBe(200);
      samples.push(result.ms);
      segments = result.json;
    }
    console.info(
      `segment latency ms: ${samples.map((s) => Math.round(s)).join(', ')} p95=${Math.round(p95(samples))}`,
    );
    expect(p95(samples)).toBeLessThan(LATENCY_BUDGET_MS);
    expect(segments.length).toBeGreaterThanOrEqual(5);
    for (const segment of segments) {
      expect(segment.bbox).toHaveLength(4);
      expect(segment.score).toBeGreaterThan(0);
    }
  });

  // Needs E3 (catalog enroll) to create products with reference embeddings.
  it.todo('matches enrolled products and flags look-alikes as ambiguous');
});
