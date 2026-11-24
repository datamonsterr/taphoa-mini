import {
  BeVietnamPro_500Medium,
  BeVietnamPro_700Bold,
  BeVietnamPro_800ExtraBold,
} from '@expo-google-fonts/be-vietnam-pro';
import { loadAsync } from 'expo-font';

/** Keep the app usable with platform fallback fonts if a deferred download fails. */
export async function loadDeferredFonts(): Promise<void> {
  try {
    await loadAsync({
      BeVietnamPro_500Medium,
      BeVietnamPro_700Bold,
      BeVietnamPro_800ExtraBold,
    });
  } catch {
    // Font loading is optional; the platform uses its fallback for unavailable faces.
  }
}
