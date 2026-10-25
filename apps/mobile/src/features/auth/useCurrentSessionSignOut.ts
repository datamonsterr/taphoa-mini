import { useAuth, useClerk, useSessionList } from '@clerk/expo';
import { useState } from 'react';

import { useDeviceLock } from '@/stores/deviceLock';

import { signedInSessions } from './deviceSessions';
import { useEmailFlow } from './emailFlow';

/**
 * Signs out the current Clerk session only. Clerk leaves nobody active afterwards, and nobody
 * is activated here: another person on the phone is guarded by their own PIN, so they are
 * picked (and asked for it) on the sign-in screen, which lists everyone still signed in.
 * While anyone remains, the device is locked, so a restart cannot activate them either.
 */
export function useCurrentSessionSignOut() {
  const { sessionId } = useAuth();
  const { signOut } = useClerk();
  const { sessions } = useSessionList();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return {
    busy,
    failed,
    available: !!sessionId,
    signOut: async () => {
      if (!sessionId || busy) return;
      setBusy(true);
      setFailed(false);
      const othersRemain = signedInSessions(sessions).some(
        ({ id }) => id !== sessionId,
      );
      try {
        await signOut({ sessionId });
        if (othersRemain) useDeviceLock.getState().lock();
        useEmailFlow.getState().reset();
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
  };
}
