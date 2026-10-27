import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getBackendUrl } from './env.js';

// 1600x1200 JPEG with 18 products, shared with the backend model tests.
export const photo = readFileSync(
  fileURLToPath(
    new URL(
      '../../../apps/backend/tests/fixtures/shelf-1600.jpg',
      import.meta.url,
    ),
  ),
);

export function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set('image', new Blob([photo], { type: 'image/jpeg' }), 'shelf.jpg');
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

export async function post(
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
export async function postRetrying(
  path: string,
  make: () => FormData,
  token: string,
) {
  for (let attempt = 0; ; attempt++) {
    const result = await post(path, make(), token);
    if (result.status !== 503 || attempt >= 5) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
