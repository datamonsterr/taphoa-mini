import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './index';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const image = {
  id: '0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3b',
  object_key: 'images/2026/10/x.jpg',
  content_type: 'image/jpeg',
  byte_size: 3,
  url: 'https://cdn.example.test/x.jpg',
  url_expires_at: '2026-10-23T10:00:00Z',
};

function setup(response: Response, token: string | null = null) {
  const fetchMock = vi.fn(async (_req: Request) => response);
  const api = createApiClient({
    baseUrl: 'https://api.example.test/',
    fetch: fetchMock as unknown as typeof fetch,
    getToken: () => token,
  });
  return { api, fetchMock };
}

describe('api client', () => {
  it('getHealth calls GET /healthz and returns typed data', async () => {
    const { api, fetchMock } = setup(json({ status: 'ok' }));
    const { data, error } = await api.getHealth();
    expect(error).toBeUndefined();
    expect(data?.status).toBe('ok');
    const req = fetchMock.mock.calls[0]![0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.example.test/healthz');
  });

  it('getImage sends the bearer token and path param', async () => {
    const { api, fetchMock } = setup(json(image), 'tok');
    const { data } = await api.getImage(image.id);
    expect(data?.id).toBe(image.id);
    const req = fetchMock.mock.calls[0]![0];
    expect(req.url).toBe(`https://api.example.test/v1/images/${image.id}`);
    expect(req.headers.get('Authorization')).toBe('Bearer tok');
  });

  it('getImage surfaces error responses', async () => {
    const { api } = setup(
      json({ code: 'not_found', message: 'nope' }, 404),
      'tok',
    );
    const { data, error, response } = await api.getImage(image.id);
    expect(data).toBeUndefined();
    expect(error).toBeDefined();
    expect(response.status).toBe(404);
  });

  it('uploadImage posts multipart form data', async () => {
    const { api, fetchMock } = setup(json(image, 201), 'tok');
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    const { data, response } = await api.uploadImage(file, 'enrollment');
    expect(response.status).toBe(201);
    expect(data?.content_type).toBe('image/jpeg');
    const req = fetchMock.mock.calls[0]![0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.test/v1/images');
    expect(req.headers.get('content-type')).toMatch(/^multipart\/form-data/);
    const form = await req.formData();
    expect(form.get('purpose')).toBe('enrollment');
    expect(form.get('image')).toBeInstanceOf(Blob);
  });
});
