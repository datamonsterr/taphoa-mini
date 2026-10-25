import { useClerk } from '@clerk/expo';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import {
  deviceMeKey,
  personName,
  pinMembership,
  type DeviceSession,
} from '@/features/auth/deviceSessions';
import { fetchSessionMe, verifySessionPin } from '@/features/auth/sessionApi';
import { isApiError } from '@/lib/api/errors';
import { useT } from '@/lib/i18n';
import { useCurrentStore } from '@/stores/currentStore';
import { useDeviceLock } from '@/stores/deviceLock';

import { fill, strings } from './strings';

export type SwitchTarget = {
  session: DeviceSession;
  /** Just signed in on a locked phone: already active, so the PIN is the last step before the lock lifts. */
  fresh?: boolean;
  /** Name shown in the PIN sheet title. */
  name: string;
  /** The store whose member PIN is checked: their selected one, else any store where they have a PIN. */
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

/** How a fresh sign-in on a locked phone ended: let in, backed out of, or not decidable. */
export type AdmitResult = 'in' | 'cancelled' | 'failed';

/**
 * Switching to another person on this phone. Someone with a PIN in any of their stores (their
 * selected one first) must enter it first; the PIN is checked with *their* session token and the
 * store that holds it, and only a 204 activates their Clerk session. Anyone else is switched to
 * directly. After `setActive` the device lock is lifted: this is how the sign-in screen's person
 * picker lets somebody in.
 */
export function useSwitchSession() {
  const t = useT(strings);
  const queryClient = useQueryClient();
  const clerk = useClerk();
  const { setActive, signOut } = clerk;
  const [target, setTarget] = useState<SwitchTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped after a wrong PIN so the sheet clears the digits.
  const [attempt, setAttempt] = useState(0);
  // Who is told how a fresh sign-in ended; it can end later, once the PIN sheet is answered.
  const onDone = useRef<((result: AdmitResult) => void) | null>(null);
  const settle = useCallback((result: AdmitResult) => {
    const done = onDone.current;
    onDone.current = null;
    done?.(result);
  }, []);

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
        // That person's own selection, not the active person's; a PIN in any of their stores counts.
        const membership = pinMembership(
          me,
          useCurrentStore.getState().storeIds[
            session.user?.id ?? me.clerk_user_id
          ],
        );
        if (membership)
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

  /** Signs the just-created session out again. The lock was never lifted, so it still holds. */
  const reject = useCallback(
    async (sessionId: string | null, result: 'cancelled' | 'failed') => {
      try {
        if (sessionId) await signOut({ sessionId });
        settle(result);
      } catch {
        settle('failed');
      }
    },
    [signOut, settle],
  );

  /**
   * A person who has just signed in (email code or Google) while the phone is locked. They are
   * Clerk-active already, but the lock only lifts once any PIN they have is accepted: with a PIN
   * the sheet opens, and closing it or failing to find out signs that new session out again.
   * `done` hears the outcome, now or after the sheet is answered. Without a lock nothing is asked.
   */
  const admit = useCallback(
    async (
      sessionId: string | null,
      wasLocked: boolean,
      done?: (result: AdmitResult) => void,
    ) => {
      onDone.current = done ?? null;
      if (!wasLocked) {
        useDeviceLock.getState().unlock();
        settle('in');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        // The client is read now: the session list of this render predates the new session.
        const session = sessionId
          ? clerk.client?.sessions.find(({ id }) => id === sessionId)
          : undefined;
        if (!session) {
          await reject(sessionId, 'failed');
          return;
        }
        let me;
        try {
          me = await queryClient.fetchQuery({
            queryKey: deviceMeKey(session.id),
            queryFn: () => fetchSessionMe(session),
            staleTime: 0,
          });
        } catch {
          await reject(session.id, 'failed');
          return;
        }
        const membership = pinMembership(
          me,
          useCurrentStore.getState().storeIds[
            session.user?.id ?? me.clerk_user_id
          ],
        );
        if (membership)
          setTarget({
            session,
            fresh: true,
            name: personName(session, me) || t('sessions.unknown'),
            storeId: membership.store.id,
          });
        else {
          useDeviceLock.getState().unlock();
          settle('in');
        }
      } finally {
        setBusy(false);
      }
    },
    [clerk, queryClient, reject, settle, t],
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
      if (target.fresh) {
        // Already the active session: the right PIN is what the lock was waiting for.
        useDeviceLock.getState().unlock();
        settle('in');
      } else await activate(target.session);
      setBusy(false);
    },
    [target, busy, activate, settle, t],
  );

  const cancel = useCallback(() => {
    setTarget(null);
    setError(null);
    if (target?.fresh) {
      setBusy(true);
      void reject(target.session.id, 'cancelled').finally(() => setBusy(false));
    }
  }, [target, reject]);

  return { target, error, busy, attempt, begin, admit, submitPin, cancel };
}
