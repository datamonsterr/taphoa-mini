import {
  ApiError,
  apiErrorText,
  isApiError,
  isRateLimited,
  unwrap,
} from './errors';

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
  expect(apiError.message).toBe(
    'Không tìm thấy dữ liệu này. Có thể nó đã bị xóa.',
  );
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

test('unwrap carries Retry-After as milliseconds', async () => {
  const withHeader = (value: string | null) =>
    ({
      status: 503,
      statusText: '',
      ok: false,
      headers: new Headers(value === null ? {} : { 'retry-after': value }),
    }) as Response;
  const get = (value: string | null) =>
    unwrap(
      Promise.resolve({
        error: { error: 'busy' },
        response: withHeader(value),
      }),
    ).catch((e: unknown) => (e as ApiError).retryAfterMs);
  expect(await get('2')).toBe(2000);
  expect(await get(null)).toBeUndefined();
  expect(await get('soon')).toBeUndefined();
});

test('isRateLimited is true only for HTTP 429', () => {
  expect(isRateLimited(new ApiError(429, { error: 'x' }))).toBe(true);
  expect(isRateLimited(new ApiError(503, { error: 'x' }))).toBe(false);
  expect(isRateLimited(new Error('429'))).toBe(false);
});

test('ApiError.message is a Vietnamese sentence, never the server text', () => {
  const forbidden = new ApiError(403, { error: 'permission denied' });
  expect(forbidden.message).toBe('Bạn không có quyền làm việc này.');
  expect(forbidden.body.error).toBe('permission denied');
  expect(new ApiError(413, { error: 'Payload Too Large' }).message).toMatch(
    /Ảnh quá lớn/,
  );
  expect(new ApiError(415, { error: 'expected JPEG' }).message).toMatch(
    /Định dạng ảnh/,
  );
  expect(new ApiError(409, { error: 'conflict' }).message).toMatch(/tải lại/);
  expect(new ApiError(503, { error: 'down' }).message).toMatch(/Máy chủ/);
  expect(new ApiError(429, { error: 'slow' }, 30_000).message).toBe(
    'Bạn thao tác quá nhanh. Thử lại sau 30 giây.',
  );
});

test('apiErrorText maps a non-API error to the network sentence', () => {
  expect(apiErrorText(new TypeError('Network request failed'))).toMatch(
    /Không kết nối được/,
  );
  expect(apiErrorText(new ApiError(500, { error: 'x' }))).toMatch(/Máy chủ/);
});
