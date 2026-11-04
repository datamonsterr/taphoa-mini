import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  initialSettings,
  SETTINGS_STORAGE_KEY,
  useSettingsStore,
} from './settings';

beforeEach(() => useSettingsStore.setState(initialSettings));

test('defaults: Vietnamese, normal size, elder mode off', () => {
  const s = useSettingsStore.getState();
  expect(s.language).toBe('vi');
  expect(s.fontScale).toBe(1);
  expect(s.elderMode).toBe(false);
});

test('setters update state', () => {
  const s = useSettingsStore.getState();
  s.setElderMode(true);
  s.setFontScale(1.25);
  s.setLanguage('en');
  expect(useSettingsStore.getState()).toMatchObject({
    elderMode: true,
    fontScale: 1.25,
    language: 'en',
  });
});

test('persists choices to AsyncStorage', async () => {
  useSettingsStore.getState().setFontScale(1.5);
  useSettingsStore.getState().setLanguage('en');
  const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
  expect(JSON.parse(raw!).state).toEqual({
    elderMode: false,
    speakTotal: false,
    fontScale: 1.5,
    language: 'en',
  });
});

test('restores saved settings on launch', async () => {
  await AsyncStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      state: {
        elderMode: true,
        speakTotal: false,
        fontScale: 1.75,
        language: 'en',
      },
      version: 2,
    }),
  );
  await useSettingsStore.persist.rehydrate();
  expect(useSettingsStore.getState()).toMatchObject({
    elderMode: true,
    fontScale: 1.75,
    language: 'en',
  });
  expect(useSettingsStore.persist.hasHydrated()).toBe(true);
});

test('elder mode turns the spoken total on; it can be switched off after', () => {
  useSettingsStore.getState().setElderMode(true);
  expect(useSettingsStore.getState().speakTotal).toBe(true);
  useSettingsStore.getState().setSpeakTotal(false);
  useSettingsStore.getState().setElderMode(false);
  expect(useSettingsStore.getState()).toMatchObject({
    elderMode: false,
    speakTotal: false,
  });
});

test('migrates v1 settings: elder users get the spoken total', async () => {
  await AsyncStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      state: { elderMode: true, fontScale: 1.25, language: 'vi' },
      version: 1,
    }),
  );
  await useSettingsStore.persist.rehydrate();
  expect(useSettingsStore.getState()).toMatchObject({
    elderMode: true,
    speakTotal: true,
  });
});
