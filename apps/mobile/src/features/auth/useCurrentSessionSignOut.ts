import { useAuth, useClerk } from '@clerk/expo';
import { useState } from 'react';
import { useEmailFlow } from './emailFlow';

export function useCurrentSessionSignOut() {
  const { sessionId } = useAuth();
  const { signOut } = useClerk();
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
      try {
        await signOut({ sessionId });
        useEmailFlow.getState().reset();
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
  };
}
