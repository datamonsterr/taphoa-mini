import {
  authErrorKey,
  authFailureKey,
  clerkErrorCode,
  codeExpiry,
  codeWasSent,
} from './errors';

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
  ['form_identifier_not_found', 'unknownEmail'],
  ['identifier_already_signed_in', 'alreadySignedIn'],
  ['session_exists', 'alreadySignedIn'],
  ['user_locked', 'locked'],
  ['not_allowed_access', 'notAllowed'],
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

test('finds the code and the status wherever the Core 3 wrapper put them', () => {
  expect(
    authErrorKey({
      code: 'api_response_error',
      cause: { errors: [{ code: 'verification_expired' }] },
    }),
  ).toBe('expiredCode');
  expect(authErrorKey({ errors: [{ code: 'form_code_incorrect' }] })).toBe(
    'wrongCode',
  );
  expect(authErrorKey({ status: 429, cause: { message: 'slow down' } })).toBe(
    'rateLimited',
  );
  expect(authErrorKey({ cause: { status: 429 } })).toBe('rateLimited');
});
test('a wrapped fetch failure or an offline message is a network error', () => {
  expect(
    authErrorKey({ code: 'unexpected_error', cause: new TypeError('x') }),
  ).toBe('network');
  expect(authErrorKey({ name: 'TypeError', message: 'Load failed' })).toBe(
    'network',
  );
  expect(authErrorKey(new Error('Network request failed while offline'))).toBe(
    'network',
  );
  expect(authErrorKey(new Error('Something else broke'))).toBe('generic');
  // an API answer that merely mentions a network word stays what its code says
  expect(
    authErrorKey({
      message: 'network policy',
      errors: [{ code: 'form_code_incorrect' }],
    }),
  ).toBe('wrongCode');
});
test('authFailureKey reads result.error, then the resource errors, then the network state', () => {
  expect(
    authFailureKey({ error: { code: 'verification_expired' } }, {}, true),
  ).toBe('expiredCode');
  expect(
    authFailureKey(
      { error: null },
      { errors: { raw: [{ code: 'too_many_requests' }], global: null } },
      true,
    ),
  ).toBe('rateLimited');
  expect(
    authFailureKey(
      { error: null },
      { errors: { raw: null, global: [{ message: 'odd' }], fields: {} } },
      true,
    ),
  ).toBe('generic');
  expect(
    authFailureKey(
      { error: null },
      {
        errors: {
          raw: null,
          global: null,
          fields: { code: { code: 'form_code_incorrect' } },
        },
      },
      true,
    ),
  ).toBe('wrongCode');
  expect(authFailureKey({ error: null }, {}, false)).toBe('network');
  expect(authFailureKey({ error: null }, {}, true)).toBeUndefined();
  expect(authFailureKey(undefined, undefined, true)).toBeUndefined();
});
test('codeWasSent tells a sent code from a quiet no-op by its expiry', () => {
  const at = (ms: number | null) => ({
    firstFactorVerification: { expireAt: ms === null ? null : new Date(ms) },
  });
  expect(codeExpiry(at(5000), 'signIn')).toBe(5000);
  expect(codeExpiry(at(null), 'signIn')).toBeNull();
  expect(codeExpiry({}, 'signIn')).toBeNull();
  expect(codeWasSent(at(9000), 'signIn', null)).toBe(true);
  expect(codeWasSent(at(9000), 'signIn', 5000)).toBe(true);
  expect(codeWasSent(at(5000), 'signIn', 5000)).toBe(false);
  expect(codeWasSent(at(null), 'signIn', null)).toBe(false);
  // a resource that keeps no verification state cannot say, so it counts as sent
  expect(codeWasSent({}, 'signIn', null)).toBe(true);
  expect(codeWasSent(undefined, 'signUp', null)).toBe(true);
  expect(
    codeWasSent(
      { verifications: { emailAddress: { expireAt: 7 } } },
      'signUp',
      1,
    ),
  ).toBe(true);
  expect(
    codeWasSent(
      { verifications: { emailAddress: { expireAt: 1 } } },
      'signUp',
      1,
    ),
  ).toBe(false);
});
