import { createMockFetch } from './fetch';
import { getMockDb, resetMockDb, registerImage } from './db';
import { newUuid } from '@/lib/uuid';

const base = 'http://mock.local';
const mockFetch = createMockFetch();
beforeEach(resetMockDb);

const send = (method: string, path: string, body?: unknown) =>
  mockFetch(
    new Request(base + path, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: typeof body === 'string' ? body : JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
          }),
    }),
  );

describe('POST /v1/segment/points', () => {
  test('returns 200 with deterministic response and creates cutout image with purpose crop', async () => {
    const img = registerImage({
      contentType: 'image/jpeg',
      byteSize: 1000,
      purpose: 'enrollment',
    });

    const res = await send('POST', '/v1/segment/points', {
      image_id: img.id,
      points: [
        { x: 100, y: 150, label: 1 },
        { x: 200, y: 250, label: 0 },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bbox: number[];
      score: number;
      area: number;
      mask: { width: number; height: number; png_base64: string };
      cutout_image_id: string;
      timings: { encode: number; decode: number; total: number };
    };

    expect(Array.isArray(body.bbox)).toBe(true);
    expect(body.bbox).toHaveLength(4);
    expect(typeof body.score).toBe('number');
    expect(typeof body.area).toBe('number');
    expect(body.mask.png_base64).toBeTruthy();
    expect(body.mask.width).toBeGreaterThan(0);
    expect(body.mask.height).toBeGreaterThan(0);
    expect(body.timings).toBeDefined();

    // Stored cutout image exists in DB with purpose 'crop'
    const cutout = getMockDb().images.get(body.cutout_image_id);
    expect(cutout).toBeDefined();
    expect(cutout?.purpose).toBe('crop');
  });

  test('returns 422 when points array is empty or has > 2 points or invalid label', async () => {
    const img = registerImage({
      contentType: 'image/jpeg',
      byteSize: 1000,
      purpose: 'enrollment',
    });

    // 0 points
    const res0 = await send('POST', '/v1/segment/points', {
      image_id: img.id,
      points: [],
    });
    expect(res0.status).toBe(422);

    // 3 points
    const res3 = await send('POST', '/v1/segment/points', {
      image_id: img.id,
      points: [
        { x: 1, y: 1, label: 1 },
        { x: 2, y: 2, label: 1 },
        { x: 3, y: 3, label: 0 },
      ],
    });
    expect(res3.status).toBe(422);

    // invalid label
    const resLabel = await send('POST', '/v1/segment/points', {
      image_id: img.id,
      points: [{ x: 1, y: 1, label: 2 }],
    });
    expect(resLabel.status).toBe(422);
  });

  test('returns 404 when image_id does not exist', async () => {
    const res = await send('POST', '/v1/segment/points', {
      image_id: newUuid(),
      points: [{ x: 100, y: 100, label: 1 }],
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/products with references & index_status', () => {
  const createImages = (count: number) => {
    const refs = [];
    for (let i = 0; i < count; i++) {
      const orig = registerImage({
        contentType: 'image/jpeg',
        byteSize: 1000,
        purpose: 'enrollment',
      });
      const cutout = registerImage({
        contentType: 'image/png',
        byteSize: 500,
        purpose: 'crop',
      });
      refs.push({
        image_id: orig.id,
        cutout_image_id: cutout.id,
        bbox: [10, 10, 100, 100],
      });
    }
    return refs;
  };

  test('returns 422 when references < 3', async () => {
    const refs = createImages(2);
    const res = await send('POST', '/v1/products', {
      id: newUuid(),
      price: 10000,
      references: refs,
    });
    expect(res.status).toBe(422);
  });

  test('returns 409 image_limit when references > 8', async () => {
    const refs = createImages(9);
    const res = await send('POST', '/v1/products', {
      id: newUuid(),
      price: 10000,
      references: refs,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'image_limit' });
  });

  test('returns product with index_status pending, next GET returns ready', async () => {
    const refs = createImages(3);
    const id = newUuid();
    const res = await send('POST', '/v1/products', {
      id,
      price: 10000,
      name: 'Test Product',
      references: refs,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { index_status: string; id: string };
    expect(created.index_status).toBe('pending');

    // Next GET returns ready
    const getRes = await send('GET', `/v1/products/${id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { index_status: string };
    expect(fetched.index_status).toBe('ready');
  });

  test('legacy image_ids also creates with pending and next GET returns ready', async () => {
    const img = registerImage({
      contentType: 'image/jpeg',
      byteSize: 1000,
      purpose: 'enrollment',
    });
    const id = newUuid();
    const res = await send('POST', '/v1/products', {
      id,
      price: 15000,
      name: 'Legacy Product',
      image_ids: [img.id],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { index_status: string };
    expect(created.index_status).toBe('pending');

    // Next GET returns ready
    const getRes = await send('GET', `/v1/products/${id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { index_status: string };
    expect(fetched.index_status).toBe('ready');
  });
});
