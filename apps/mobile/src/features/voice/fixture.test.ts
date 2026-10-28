import { Platform } from 'react-native';

import {
  clipToUpload,
  fixtureBytes,
  fixtureClip,
  fixtureName,
  voiceFixturesEnabled,
} from './fixture';

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.EXPO_PUBLIC_VOICE_FIXTURES;
});

test('a fixture param is honoured in development builds', () => {
  expect(voiceFixturesEnabled()).toBe(true);
  expect(fixtureName('two-line-sale.m4a')).toBe('two-line-sale.m4a');
});

test('a production build ignores the param unless the e2e flag is set', () => {
  const dev = (globalThis as unknown as { __DEV__: boolean }).__DEV__;
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
  try {
    expect(fixtureName('two-line-sale.m4a')).toBeUndefined();
    process.env.EXPO_PUBLIC_VOICE_FIXTURES = '1';
    expect(fixtureName('two-line-sale.m4a')).toBe('two-line-sale.m4a');
  } finally {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = dev;
  }
});

test.each([undefined, '', '../etc/passwd', 'clip.mp3', 'a b.m4a', 'UP.m4a'])(
  'rejects %p as a fixture name',
  (name) => {
    expect(fixtureName(name)).toBeUndefined();
  },
);

test('native upload part carries uri, name, type and bytes for Expo fetch', async () => {
  const { audio, filename } = await clipToUpload(fixtureClip('no-speech.m4a'));
  expect(filename).toBe('no-speech.m4a');
  expect(audio).toMatchObject({ name: 'no-speech.m4a', type: 'audio/mp4' });
  const part = audio as { bytes: () => Promise<Uint8Array> };
  expect((await part.bytes()).length).toBeGreaterThan(0);
});

test('the web uploads a Blob', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const { audio } = await clipToUpload(fixtureClip('two-line-sale.m4a'));
  expect(audio).toBeInstanceOf(Blob);
  expect((audio as Blob).type).toBe('audio/mp4');
});

test('fixture bytes embed the answer the scripted backend model reads', () => {
  const text = new TextDecoder().decode(fixtureBytes('two-line-sale.m4a'));
  const json = text.slice(text.indexOf('VOICE_PARSE=') + 'VOICE_PARSE='.length);
  expect(JSON.parse(json)).toMatchObject({
    intent: 'sale',
    payment_method: 'cash',
    lines: [
      { spoken: 'coca', quantity: 2 },
      { spoken: 'pepsi', quantity: 1 },
    ],
  });
});

test('a clip with no scripted answer carries no marker (heard as silence)', () => {
  expect(new TextDecoder().decode(fixtureBytes('no-speech.m4a'))).not.toContain(
    'VOICE_PARSE=',
  );
});

test.each([
  'two-line-sale.m4a',
  'noisy-sale.m4a',
  'single-sale.m4a',
  'transfer-sale.m4a',
  'credit-sale.m4a',
  'ambiguous.m4a',
  'unknown-product.m4a',
  'price-shorthand.m4a',
  'chat-intent.m4a',
])('%s has a parseable embedded answer', (name) => {
  const text = new TextDecoder().decode(fixtureBytes(name));
  expect(() =>
    JSON.parse(text.slice(text.indexOf('VOICE_PARSE=') + 12)),
  ).not.toThrow();
});
