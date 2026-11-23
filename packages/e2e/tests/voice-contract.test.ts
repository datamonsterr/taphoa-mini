import { describe, expect, it } from 'vitest';
import { assertErrorResponse, createStore } from '../src/helpers.js';
import { getBackendUrl } from '../src/env.js';

function form(audio: Buffer, mode = 'sale') {
  const body = new FormData();
  body.set(
    'audio',
    new Blob([new Uint8Array(audio)], { type: 'audio/mp4' }),
    'clip.m4a',
  );
  body.set('mode', mode);
  body.set('language', 'vi');
  body.set('context', JSON.stringify({ entry: 'chat', screen: 'e2e' }));
  return body;
}

describe('voice request contracts', () => {
  it('requires authentication', async () => {
    const response = await fetch(`${getBackendUrl()}/v1/voice/utterances`, {
      method: 'POST',
      body: form(Buffer.from('not audio')),
    });
    expect(response.status).toBe(401);
    assertErrorResponse(await response.json(), 'unauthorized');
  });

  it('rejects unsupported audio with 400 unsupported_format', async () => {
    const store = await createStore();
    const response = await fetch(`${getBackendUrl()}/v1/voice/utterances`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${store.session.access_token}`,
        'x-store-id': store.session.store.id,
      },
      body: form(Buffer.from('not audio at all, just text')),
    });
    expect(response.status).toBe(400);
    assertErrorResponse(await response.json(), 'unsupported_format');
  });
});
