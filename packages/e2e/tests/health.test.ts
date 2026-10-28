import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertErrorResponse, createStore, newClient } from '../src/helpers.js';

describe('Health & Infrastructure Contract Specs (E1)', () => {
  it('GET /healthz returns 200 with { status: "ok" }', async () => {
    const client = newClient();
    const { data, error, response } = await client.raw.GET('/healthz');

    expect(response.status).toBe(200);
    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    expect(data!.status).toBe('ok');
  });

  it('GET /readyz returns 200 indicating dependencies are healthy', async () => {
    const client = newClient();
    const { data, error, response } = await client.raw.GET('/readyz');

    expect(response.status).toBe(200);
    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    expect(data!.status).toBe('ok');
  });

  describe('POST /v1/images authorization and contract', () => {
    const samplePngUrl = new URL(
      '../../../apps/backend/tests/fixtures/sample.png',
      import.meta.url,
    );
    const samplePngBuffer = readFileSync(samplePngUrl);

    it('rejects upload without token with 401 code unauthorized', async () => {
      const client = newClient();
      const file = new File([samplePngBuffer], 'sample.png', {
        type: 'image/png',
      });

      const { data, error, response } = await client.uploadImage(
        file,
        'enrollment',
      );

      expect(response.status).toBe(401);
      expect(data).toBeUndefined();
      assertErrorResponse(error, 'unauthorized');
    });

    it('accepts upload with valid lead token returning 201 (or skips on 503 if storage unconfigured)', async (ctx) => {
      const { client: leadClient } = await createStore();
      const file = new File([samplePngBuffer], 'sample.png', {
        type: 'image/png',
      });

      const { data, error, response } = await leadClient.uploadImage(
        file,
        'enrollment',
      );

      // Skip test if storage is not configured in this test environment
      if (response.status === 503) {
        ctx.skip();
        return;
      }

      expect(response.status).toBe(201);
      expect(error).toBeUndefined();
      expect(data).toBeDefined();

      expect(typeof data!.id).toBe('string');
      expect(typeof data!.object_key).toBe('string');
      expect(data!.content_type).toBe('image/png');
      expect(data!.byte_size).toBe(samplePngBuffer.length);
      expect(typeof data!.url).toBe('string');
      expect(typeof data!.url_expires_at).toBe('string');

      // Exercise the public object-store endpoint with only the presigned URL.
      const download = await fetch(data!.url);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toMatch(/^image\//i);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(
        samplePngBuffer,
      );
    });
  });
});
