import { Asset } from 'expo-asset';

import { productImageUri } from './assets';

afterEach(() => jest.restoreAllMocks());

test('returns the uri Asset resolves for the bundled image', () => {
  jest
    .spyOn(Asset, 'fromModule')
    .mockReturnValue({ uri: 'http://192.168.1.2:8081/coca.png' } as Asset);
  expect(productImageUri('coca')).toBe('http://192.168.1.2:8081/coca.png');
});

test('falls back to a valid https uri when the asset does not resolve', () => {
  jest.spyOn(Asset, 'fromModule').mockReturnValue({ uri: '' } as Asset);
  const uri = productImageUri('7up');
  expect(uri).toBe('https://mock.local/assets/products/7up.png');
  expect(() => new URL(uri)).not.toThrow();
});

test('falls back when the asset is missing from the registry', () => {
  jest.spyOn(Asset, 'fromModule').mockImplementation(() => {
    throw new Error('missing from the asset registry');
  });
  expect(productImageUri('oreo')).toBe(
    'https://mock.local/assets/products/oreo.png',
  );
});

test('does not use Image.resolveAssetSource (absent on react-native-web)', () => {
  const uri = productImageUri('coca');
  expect(() => new URL(uri)).not.toThrow();
});
