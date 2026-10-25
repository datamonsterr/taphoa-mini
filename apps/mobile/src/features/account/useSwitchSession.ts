import { useClerk } from '@clerk/expo';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import {
  deviceMeKey,
  personName,
  type DeviceSession,
} from '@/features/auth/deviceSessions';
import { fetchSessionMe, verifySessionPin } from '@/features/auth/sessionApi';
import { isApiError } from '@/lib/api/errors';
import { useT } from '@/lib/i18n';
import { resolveMembership, useCurrentStore } from '@/stores/currentStore';
import { useDeviceLock } from '@/stores/deviceLock';

import { fill, strings } from './strings';

export type SwitchTarget = {
  session: DeviceSession;
  /** Name shown in the PIN sheet title. */
  name: string;
  /** The store whose member PIN is checked: the one that person has selected. */
  storeId: string;
};

/** `45 s` or `5 min` from a Retry-After in milliseconds, rounded up; null when the server sent none. */
function waitText(
  t: (key: string) => string,
  retryAfterMs: number | undefined,
): string | null {
  if (retryAfterMs === undefined) return null;
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return seconds < 60
    ? fill(t('wait.seconds'), { n: seconds })
    : fill(t('wait.minutes'), { n: Math.ceil(seconds / 60) });
}

/**
 * Switching to another person on this phone. Someone with a PIN in the store they last used
 * must enter it first; the PIN is checked with *their* session token and store, and only a 204
 * activates their Clerk session. Anyone else is switched to directly. After `setActive` the
 * device lock is lifted: this is how the sign-in screen's person picker lets somebody in.
 */
export function useSwitchSession() {
  const t = useT(strings);
  const queryClient = useQueryClient();
  const { setActive } = useClerk();
  const [target, setTarget] = useState<SwitchTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped after a wrong PIN so the sheet clears the digits.
  const [attempt, setAttempt] = useState(0);

  const activate = useCallback(
    async (session: DeviceSession): Promise<boolean> => {
      try {
        await setActive({ session: session.id, navigate: async () => {} });
        // The picked person is in: only now does the device lock (if any) lift.
        useDeviceLock.getState().unlock();
        return true;
      } catch {
        setError(t('sessions.error'));
        return false;
      }
    },
    [setActive, t],
  );

  const begin = useCallback(
    async (session: DeviceSession) => {
      if (busy || target) return;
      setBusy(true);
      setError(null);
      try {
        // Always fresh: a cached "no PIN" must never let someone skip a PIN set meanwhile.
        const me = await queryClient.fetchQuery({
          queryKey: deviceMeKey(session.id),
          queryFn: () => fetchSessionMe(session),
          staleTime: 0,
        });
        // That person's own selection (else their first store), not the active person's.
        const membership = resolveMembership(
          me.memberships,
          useCurrentStore.getState().storeIds[
            session.user?.id ?? me.clerk_user_id
          ],
        );
        if (membership?.member.has_pin)
          setTarget({
            session,
            name: personName(session, me) || t('sessions.unknown'),
            storeId: membership.store.id,
          });
        else await activate(session);
      } catch {
        // Not knowing whether a PIN exists, nobody is switched.
        setError(t('sessions.error'));
      } finally {
        setBusy(false);
      }
    },
    [busy, target, queryClient, activate, t],
  );

  const submitPin = useCallback(
    async (pin: string) => {
      if (!target || busy) return;
      setBusy(true);
      setError(null);
      try {
        await verifySessionPin(target.session, target.storeId, pin);
      } catch (failure) {
        if (isApiError(failure) && failure.code === 'invalid_pin') {
          setAttempt((count) => count + 1);
          setError(t('switch.wrongPin'));
        } else if (isApiError(failure) && failure.status === 429) {
          const wait = waitText(t, failure.retryAfterMs);
          setAttempt((count) => count + 1);
          setError(
            wait
              ? fill(t('switch.locked'), { wait })
              : t('switch.lockedNoWait'),
          );
        } else setError(t('switch.verifyError'));
        setBusy(false);
        return;
      }
      setTarget(null);
      await activate(target.session);
      setBusy(false);
    },
    [target, busy, activate, t],
  );

  const cancel = useCallback(() => {
    setTarget(null);
    setError(null);
  }, []);

  return { target, error, busy, attempt, begin, submitPin, cancel };
}
