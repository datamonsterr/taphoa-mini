import { useEffect } from 'react';
import { Platform } from 'react-native';
import { selectSignedIn, useSessionStore } from '@/stores/session';
import { incrementOpens, markAsked, shouldPromptForPush } from './promptTiming';
import {
  getPushPermission,
  registerForPush,
  requestPushPermission,
} from './push';

/**
 * Hook mounted on the shop layout:
 * - On mount while signed in: increments opens
 * - If permission already granted: registerForPush (upsert on start keeps token/version fresh)
 * - Else if shouldPromptForPush: marks asked, requests permission, and registers when granted
 * - Never prompts on the first signed-in open
 * - No-op on web and when not signed in
 */
export function usePushRegistration(): void {
  const signedIn = useSessionStore(selectSignedIn);

  useEffect(() => {
    if (Platform.OS === 'web' || !signedIn) return;

    let cancelled = false;

    async function syncPush() {
      const state = await incrementOpens();
      if (cancelled) return;

      const permission = await getPushPermission();
      if (cancelled) return;

      if (permission?.granted) {
        await registerForPush();
        return;
      }

      if (
        shouldPromptForPush({
          signedInOpens: state.opens,
          asked: state.asked,
          platform: Platform.OS,
        })
      ) {
        await markAsked();
        if (cancelled) return;

        const requested = await requestPushPermission();
        if (cancelled) return;

        if (requested?.granted) {
          await registerForPush();
        }
      }
    }

    void syncPush();

    return () => {
      cancelled = true;
    };
  }, [signedIn]);
}
