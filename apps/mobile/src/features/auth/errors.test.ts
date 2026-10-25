import { authErrorKey, clerkErrorCode } from './errors';

test.each([
  ['form_code_incorrect', 'wrongCode'],
  ['verification_failed', 'wrongCode'],
  ['verification_expired', 'expiredCode'],
  ['form_code_expired', 'expiredCode'],
  ['too_many_requests', 'rateLimited'],
  ['too_many_attempts', 'rateLimited'],
  ['rate_limit_exceeded', 'rateLimited'],
  ['network_error', 'network'],
  ['network_request_failed', 'network'],
  ['api_request_failed', 'network'],
  ['unexpected', 'generic'],
])('maps Clerk %s to a localized friendly message key', (code, key) => {
  expect(authErrorKey({ code })).toBe(key);
});
test('unwraps Core 3 API causes and SSO error lists', () => {
  expect(
    clerkErrorCode({
      code: 'api_response_error',
      cause: { errors: [{ code: 'form_identifier_not_found' }] },
    }),
  ).toBe('form_identifier_not_found');
  expect(clerkErrorCode(undefined)).toBeUndefined();
  expect(clerkErrorCode('offline')).toBeUndefined();
  expect(authErrorKey(new TypeError('Network request failed'))).toBe('network');
});
