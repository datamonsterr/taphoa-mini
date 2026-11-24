import { loadAsync } from 'expo-font';
import {
  BeVietnamPro_500Medium,
  BeVietnamPro_700Bold,
  BeVietnamPro_800ExtraBold,
} from '@expo-google-fonts/be-vietnam-pro';

import { loadDeferredFonts } from './deferredFonts';

test('requests all deferred weights and handles a failed load once', async () => {
  const load = jest.mocked(loadAsync);
  load.mockRejectedValueOnce(new Error('network'));
  await expect(loadDeferredFonts()).resolves.toBeUndefined();
  expect(load).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledWith({
    BeVietnamPro_500Medium,
    BeVietnamPro_700Bold,
    BeVietnamPro_800ExtraBold,
  });
});
