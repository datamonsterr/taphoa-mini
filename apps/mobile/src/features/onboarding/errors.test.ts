import { ApiError } from '@/lib/api/errors';

import { onboardingErrorKey } from './errors';

const api = (status: number, code?: string) =>
  new ApiError(status, { error: 'x', ...(code ? { code } : {}) });

test.each([
  [api(400), 'error.invalid'],
  [api(401), 'error.session'],
  [api(403), 'error.forbidden'],
  [api(409, 'already_member'), 'error.alreadyMember'],
  [api(409, 'other'), 'error.generic'],
  [api(410), 'error.invite'],
  [api(429), 'error.rateLimit'],
  [api(500), 'error.server'],
  [api(418), 'error.generic'],
  [new TypeError('offline'), 'error.network'],
])('maps %p to %s', (error, key) => {
  expect(onboardingErrorKey(error)).toBe(key);
});
test('a caller can word a 401 differently', () => {
  expect(onboardingErrorKey(api(401), 'error.generic')).toBe('error.generic');
});
