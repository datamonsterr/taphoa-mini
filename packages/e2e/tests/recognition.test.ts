import { describe, expect, it } from 'vitest';
import { form, post, postRetrying } from '../src/recognition-http.js';
import { createStore } from '../src/helpers.js';

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

  // Needs E3 (catalog enroll) to create products with reference embeddings.
  it.todo('matches enrolled products and flags look-alikes as ambiguous');
});
