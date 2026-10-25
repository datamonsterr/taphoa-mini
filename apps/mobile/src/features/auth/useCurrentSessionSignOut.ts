import { useAuth, useClerk, useSessionList } from '@clerk/expo';
import { useState } from 'react';
import { signedInSessions } from './deviceSessions';
import { useEmailFlow } from './emailFlow';

/**
 * Signs out the current Clerk session only. Clerk leaves nobody active after removing it, so
 * the next signed-in person on this phone is activated afterwards.
 */
export function useCurrentSessionSignOut() {
  const { sessionId } = useAuth();
  const { signOut, setActive } = useClerk();
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
      const next = signedInSessions(sessions).find(
        ({ id }) => id !== sessionId,
      );
      try {
        await signOut({ sessionId });
        useEmailFlow.getState().reset();
        if (next)
          await setActive({ session: next.id, navigate: async () => {} });
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
  };
}
