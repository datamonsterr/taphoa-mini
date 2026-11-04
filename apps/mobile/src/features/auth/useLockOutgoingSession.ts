import { useAuth, useSessionList } from '@clerk/expo';
import { useEffect, useRef } from 'react';

import { lockSession } from './sessionApi';

/**
 * On a shared phone every signed-in person keeps a live Clerk session, so a token alone proves
 * nothing about who holds the phone. When another person becomes the active one, the person who
 * stops being active is locked on the server: their requests get `pin_required` until their PIN
 * is verified again (`POST /v1/me/pin/verify`, which only the picker and the PIN sheet send).
 * Without a PIN anywhere the lock has no effect.
 */
export function useLockOutgoingSession(): void {
  const { sessionId } = useAuth();
  const { sessions } = useSessionList();
  const latest = useRef(sessions);
  useEffect(() => {
    latest.current = sessions;
  });
  const last = useRef<string | null>(null);
  useEffect(() => {
    // A signed-out moment in the middle of a switch keeps the last active person in `last`.
    if (!sessionId) return;
    const previous = last.current;
    last.current = sessionId;
    if (!previous || previous === sessionId) return;
    const outgoing = latest.current?.find((session) => session.id === previous);
    if (outgoing && outgoing.status === 'active') void lockSession(outgoing);
  }, [sessionId]);
}
