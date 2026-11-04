import type { components } from '@taphoa/api-client';
import { describe, expect, it } from 'vitest';
import { form, post, postRetrying } from '../src/recognition-http.js';
import { createStore } from '../src/helpers.js';
import { catalogProduct } from '../src/stock-fixtures.js';

describe('recognition', () => {
  it('requires auth for scans', async () => {
    const result = await post('/v1/recognition/scans', form());
    expect(result.status).toBe(401);
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

  it('matches enrolled products and flags look-alikes as ambiguous', async () => {
    const store = await createStore();
    const token = store.session.access_token;
    const scan = async () => {
      const result = await postRetrying(
        '/v1/recognition/scans',
        () => form({ mode: 'single', top_k: '3' }),
        token,
      );
      expect(result.status, JSON.stringify(result.json)).toBe(201);
      expect(result.json.detections).toHaveLength(1);
      return result.json as components['schemas']['Scan'];
    };
    const original = await scan();
    expect(original.detections[0]!.match).toBe('unknown');

    const waitForIndex = async (productId: string) => {
      await expect
        .poll(
          async () => {
            const indexed = await store.client.raw.GET(
              '/v1/products/{productId}',
              {
                params: { path: { productId: productId } },
              },
            );
            expect(indexed.response.status).toBe(200);
            expect(indexed.data?.index_status).not.toBe('failed');
            return indexed.data?.index_status;
          },
          { timeout: 60_000, interval: 500 },
        )
        .toBe('ready');
    };

    const enroll = async (name: string) => {
      const product = await catalogProduct(store.client, name);
      // Finish the initial job before changing references, so ready cannot refer
      // to an earlier job while another one still holds the inference slot.
      await waitForIndex(product.id);
      // Reuse a detection from the real shelf fixture. The indexing API crops the
      // original with the same padding as checkout, avoiding lossy thumbnail drift.
      const added = await store.client.raw.POST(
        '/v1/products/{productId}/images',
        {
          params: { path: { productId: product.id } },
          body: {
            image_id: original.image.id,
            detection_id: original.detections[0]!.id,
          },
        },
      );
      expect(added.response.status, JSON.stringify(added.error)).toBe(201);
      await waitForIndex(product.id);
      return product.id;
    };

    const firstId = await enroll('Shelf product');
    const confident = (await scan()).detections[0]!;
    expect(confident.match).toBe('matched');
    expect(confident.candidates[0]!.product_id).toBe(firstId);
    expect(confident.candidates[0]!.similarity).toBeGreaterThanOrEqual(0.8);

    // Available fixtures contain no labeled variants. Two forced catalog entries
    // with identical references give a deterministic look-alike (zero margin).
    const secondId = await enroll('Indistinguishable shelf variant');
    const ambiguous = (await scan()).detections[0]!;
    expect(ambiguous.match).toBe('ambiguous');
    expect(ambiguous.candidates).toHaveLength(2);
    expect(
      ambiguous.candidates
        .map((candidate: { product_id: string }) => candidate.product_id)
        .sort(),
    ).toEqual([firstId, secondId].sort());
    const [best, runnerUp] = ambiguous.candidates;
    expect(best!.similarity).toBeGreaterThanOrEqual(0.8);
    expect(best!.similarity - runnerUp!.similarity).toBeGreaterThanOrEqual(0);
    expect(best!.similarity - runnerUp!.similarity).toBeLessThan(0.05);
  }, 240_000);
});
