import { ApiError } from '@/lib/api/errors';

import { enrollFailure, enrollFailureText } from './enrollError';

test('403 says the seller may not add products', () => {
  const failure = enrollFailure(new ApiError(403, { error: 'forbidden' }));
  expect(failure).toBe('forbidden');
  expect(enrollFailureText[failure]).toMatch(/chưa có quyền thêm hàng/);
});

test('413 says the photo is too large, even with a plain-text body', () => {
  const failure = enrollFailure(
    new ApiError(413, { error: 'Payload Too Large' }),
  );
  expect(failure).toBe('tooLarge');
  expect(enrollFailureText[failure]).toMatch(/Ảnh quá lớn/);
});

test('anything else keeps the generic retry message', () => {
  expect(enrollFailure(new ApiError(500, { error: 'x' }))).toBe('generic');
  expect(enrollFailure(new TypeError('Network request failed'))).toBe(
    'generic',
  );
});
