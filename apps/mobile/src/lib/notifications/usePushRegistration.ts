import { useAuth } from '@clerk/expo';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { currentStoreId } from '@/lib/api/clerkBridge';
import { useCurrentStore } from '@/stores/currentStore';
import { useDeviceLock } from '@/stores/deviceLock';

import { incrementOpens, markAsked, shouldPromptForPush } from './promptTiming';
import {
  getPushPermission,
  registerForPush,
  requestPushPermission,
} from './push';

/**
 * Hook mounted on the shop layout:
 * - On mount while signed in and a store selected: increments opens
 * - If permission already granted: registerForPush (upsert on start keeps token/version fresh)
 * - Else if shouldPromptForPush: marks asked, requests permission, and registers when granted
 * - Never prompts on the first signed-in open
 * - No-op on web and when not signed in or no store selected
 */
export function usePushRegistration(): void {
  const { isSignedIn, userId } = useAuth();
  const locked = useDeviceLock((s) => s.locked);
  const selectedStoreId = useCurrentStore((s) =>
    userId ? s.storeIds[userId] : undefined,
  );
  const storeId = selectedStoreId ?? currentStoreId();
  const signedIn = !!isSignedIn && !locked && !!storeId;

  useEffect(() => {
    if (Platform.OS === 'web' || !signedIn) return;

    let cancelled = false;

    async function syncPush() {
      try {
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
          const requested = await requestPushPermission();
          if (cancelled) return;

          await markAsked();
          if (cancelled) return;

          if (requested?.granted) {
            await registerForPush();
          }
        }
      } catch (error) {
        console.warn('Failed to sync push registration:', error);
      }
    }

    void syncPush();

    return () => {
      cancelled = true;
    };
  }, [signedIn]);
}
