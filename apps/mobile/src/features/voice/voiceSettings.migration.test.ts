import AsyncStorage from '@react-native-async-storage/async-storage';

import { VOICE_SETTINGS_KEY, useVoiceSettings } from './voiceSettings';

test('legacy placeholder opt-in never becomes donation consent', async () => {
  await AsyncStorage.setItem(
    VOICE_SETTINGS_KEY,
    JSON.stringify({ state: { donate: true, voiceSales: 7 }, version: 1 }),
  );
  await useVoiceSettings.persist.rehydrate();
  expect(useVoiceSettings.getState().donate).toBe(false);
  expect(useVoiceSettings.getState().voiceSales).toBe(7);
});
