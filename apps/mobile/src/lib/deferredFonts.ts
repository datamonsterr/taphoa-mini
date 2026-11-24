import {
  BeVietnamPro_500Medium,
  BeVietnamPro_700Bold,
  BeVietnamPro_800ExtraBold,
} from '@expo-google-fonts/be-vietnam-pro';
import { loadAsync } from 'expo-font';

let reportedFailure = false;

/** Keep the app usable with platform fallback fonts if a deferred download fails. */
export async function loadDeferredFonts(): Promise<void> {
  try {
    await loadAsync({
      BeVietnamPro_500Medium,
      BeVietnamPro_700Bold,
      BeVietnamPro_800ExtraBold,
    });
  } catch (error) {
    // The platform uses its fallback; repeated mounts should not flood diagnostics.
    if (!reportedFailure) {
      reportedFailure = true;
      console.warn('Failed to load deferred fonts:', error);
    }
  }
}
