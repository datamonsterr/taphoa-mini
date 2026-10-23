import { renderHook } from '@testing-library/react-native';

import { initialSettings, useSettingsStore } from '@/stores/settings';

import { t, useT, type Dict } from './i18n';

const dict: Dict = {
  vi: { hello: 'Xin chào', onlyVi: 'Chỉ có tiếng Việt' },
  en: { hello: 'Hello' },
};

beforeEach(() => useSettingsStore.setState(initialSettings));

describe('t', () => {
  test('defaults to Vietnamese', () => {
    expect(t(dict, 'hello')).toBe('Xin chào');
  });
  test('English', () => {
    expect(t(dict, 'hello', 'en')).toBe('Hello');
  });
  test('falls back to Vietnamese then to the key', () => {
    expect(t(dict, 'onlyVi', 'en')).toBe('Chỉ có tiếng Việt');
    expect(t(dict, 'missing', 'en')).toBe('missing');
  });
});

describe('useT', () => {
  test('follows the settings language', async () => {
    const { result, rerender } = await renderHook(() => useT(dict));
    expect(result.current('hello')).toBe('Xin chào');
    useSettingsStore.getState().setLanguage('en');
    await rerender({});
    expect(result.current('hello')).toBe('Hello');
  });
});
