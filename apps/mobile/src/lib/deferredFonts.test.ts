import { loadAsync } from 'expo-font';
import {
  BeVietnamPro_500Medium,
  BeVietnamPro_700Bold,
  BeVietnamPro_800ExtraBold,
} from '@expo-google-fonts/be-vietnam-pro';

import { loadDeferredFonts } from './deferredFonts';

test('requests all deferred weights and handles a failed load once', async () => {
  const load = jest.mocked(loadAsync);
  const error = new Error('network');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  load.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
  await expect(loadDeferredFonts()).resolves.toBeUndefined();
  await expect(loadDeferredFonts()).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith('Failed to load deferred fonts:', error);
  warn.mockRestore();
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledWith({
    BeVietnamPro_500Medium,
    BeVietnamPro_700Bold,
    BeVietnamPro_800ExtraBold,
  });
});
