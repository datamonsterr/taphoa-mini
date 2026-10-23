import { ApiError, isApiError, unwrap } from './errors';

const res = (status: number, statusText = '') =>
  ({ status, statusText, ok: status >= 200 && status < 300 }) as Response;

test('unwrap returns data on success', async () => {
  await expect(
    unwrap(Promise.resolve({ data: { a: 1 }, response: res(200) })),
  ).resolves.toEqual({ a: 1 });
});

test('unwrap tolerates empty 2xx bodies', async () => {
  await expect(
    unwrap(Promise.resolve({ response: res(204) })),
  ).resolves.toBeUndefined();
});

test('unwrap throws ApiError with status and Error body', async () => {
  const body = { error: 'Product not found', code: 'not_found' };
  const err = await unwrap(
    Promise.resolve({ error: body, response: res(404) }),
  ).catch((e: unknown) => e);
  expect(isApiError(err)).toBe(true);
  const apiError = err as ApiError;
  expect(apiError.status).toBe(404);
  expect(apiError.body).toEqual(body);
  expect(apiError.code).toBe('not_found');
  expect(apiError.message).toBe('Product not found');
});

test('unwrap builds an Error body when the server sent none', async () => {
  const a = await unwrap(
    Promise.resolve({ error: 'oops', response: res(502, 'Bad Gateway') }),
  ).catch((e: unknown) => e as ApiError);
  expect((a as ApiError).body).toEqual({ error: 'Bad Gateway' });
  const b = await unwrap(Promise.resolve({ response: res(500) })).catch(
    (e: unknown) => e as ApiError,
  );
  expect((b as ApiError).body).toEqual({ error: 'HTTP 500' });
});

test('isApiError rejects other errors', () => {
  expect(isApiError(new Error('x'))).toBe(false);
});
