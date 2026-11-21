import { useAuth } from '@clerk/expo';
import { useEffect, useRef } from 'react';

import { useMembership } from '@/features/auth/useMembership';
import { warmRecognition } from '@/lib/api/warmRecognition';
import { useOnline } from '@/lib/online';
import { useDeviceLock } from '@/stores/deviceLock';

const COOLDOWN_MS = 60_000;
let lastWarmAt = Number.NEGATIVE_INFINITY;

export function requestRecognitionWarmup(
  eligible: boolean,
  warm: () => Promise<unknown> = warmRecognition,
  now = Date.now(),
): void {
  if (!eligible || now - lastWarmAt < COOLDOWN_MS) return;
  lastWarmAt = now;
  void warm().catch(() => {});
}

export const canWarmRecognition = (input: {
  signedIn: boolean;
  locked: boolean;
  hasStore: boolean;
  online: boolean;
}): boolean =>
  input.signedIn && !input.locked && input.hasStore && input.online;

/** Warm once on an eligible capture screen entry; failures are deliberately silent. */
export function useWarmRecognition(active = true): void {
  const { isSignedIn } = useAuth();
  const locked = useDeviceLock((state) => state.locked);
  const membership = useMembership();
  const online = useOnline();
  const attempted = useRef(false);

  useEffect(() => {
    if (!active) {
      attempted.current = false;
      return;
    }
    if (attempted.current) return;
    if (
      !canWarmRecognition({
        signedIn: !!isSignedIn,
        locked,
        hasStore: !!membership?.store.id,
        online,
      })
    )
      return;
    requestRecognitionWarmup(true);
    // A recent app-wide warm can make this call a no-op; that still counts as attempted for
    // this entry. Ineligible state above does not, so loading state can resolve while mounted.
    attempted.current = true;
  }, [active, isSignedIn, locked, membership, online]);
}

/** Reset only for tests. */
export function resetWarmRecognitionThrottle(): void {
  lastWarmAt = Number.NEGATIVE_INFINITY;
}
