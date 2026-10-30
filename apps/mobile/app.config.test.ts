import type { ConfigContext } from 'expo/config';

import withGuard from './app.config';

const ctx = { config: { name: 'x', slug: 'x' } } as ConfigContext;

afterEach(() => {
  delete process.env.EAS_BUILD_PROFILE;
  delete process.env.EXPO_PUBLIC_API_URL;
  delete process.env.APP_VERSION_CODE;
  delete process.env.APP_VERSION_NAME;
});

test.each(['preview', 'production', 'test'])(
  'fails the %s build without EXPO_PUBLIC_API_URL',
  (profile) => {
    process.env.EAS_BUILD_PROFILE = profile;
    expect(() => withGuard(ctx)).toThrow(/EXPO_PUBLIC_API_URL/);
  },
);

test('passes a release build that sets EXPO_PUBLIC_API_URL', () => {
  process.env.EAS_BUILD_PROFILE = 'preview';
  process.env.EXPO_PUBLIC_API_URL = 'https://api.example.test';
  expect(withGuard(ctx)).toBe(ctx.config);
});

test('does not touch local runs, development or e2e builds', () => {
  expect(withGuard(ctx)).toBe(ctx.config);
  process.env.EAS_BUILD_PROFILE = 'development';
  expect(withGuard(ctx)).toBe(ctx.config);
  process.env.EAS_BUILD_PROFILE = 'e2e';
  expect(withGuard(ctx)).toBe(ctx.config);
});

test('stamps the CI version name and Android versionCode', () => {
  process.env.APP_VERSION_NAME = '1.0.0-test.42+e502744';
  process.env.APP_VERSION_CODE = '42';
  const out = withGuard({
    config: { name: 'x', slug: 'x', android: { package: 'p' } },
  } as ConfigContext);
  expect(out.version).toBe('1.0.0-test.42+e502744');
  expect(out.android).toEqual({ package: 'p', versionCode: 42 });
});

test.each(['0', '-1', '1.5', 'abc'])('rejects APP_VERSION_CODE %s', (code) => {
  process.env.APP_VERSION_CODE = code;
  expect(() => withGuard(ctx)).toThrow(/APP_VERSION_CODE/);
});
