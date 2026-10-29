import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useInviteIntent } from '@/features/onboarding/inviteIntent';
import { useAuth, useSessionList } from '@clerk/expo';
import { useIsRestoring, useQueryClient } from '@tanstack/react-query';
import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ActivityIndicator, View } from 'react-native';
import {
  registerAuthBridge,
  subscribeAuthBridge,
  bridgeUserId,
  serverBridgeUserId,
} from '@/lib/api/clerkBridge';
import { isApiError } from '@/lib/api/errors';
import { useMe } from '@/lib/api/hooks';
import { keys } from '@/lib/api/keys';
import type { Me } from '@/lib/api/store';
import { useDeviceLock } from '@/stores/deviceLock';
import { resolveMembership, useCurrentStore } from '@/stores/currentStore';
import { useT } from '@/lib/i18n';
import { Frame, FormError, ActionButton } from '@/features/onboarding/kit';
import { signedInSessions } from './deviceSessions';
import { useCurrentSessionSignOut } from './useCurrentSessionSignOut';
import {
  resetPersonScopedState,
  resetStoreScopedState,
} from './resetClientState';
import { strings } from './strings';
import { useLockOutgoingSession } from './useLockOutgoingSession';

type GateState = { signedIn: boolean; hasMembership: boolean };

/** What the bridge hands out while the device is locked: Clerk may have a session, the app has none. */
const noToken = async () => null;

export function AuthGate({
  children,
}: {
  children: (state: GateState) => ReactNode;
}) {
  const auth = useAuth();
  const { isLoaded, getToken } = auth;
  const { sessions, isLoaded: sessionsLoaded } = useSessionList();
  const signedInCount = signedInSessions(sessions).length;
  const locked = useDeviceLock((s) => s.locked);
  const lockHydrated = useDeviceLock((s) => s.hydrated);
  // While the device is locked, whoever Clerk has active (clerk-js picks one by itself on a cold
  // start) is not let in: for the app nobody is signed in until a person is picked.
  const isSignedIn = !!auth.isSignedIn && !locked;
  const userId = locked ? null : auth.userId;
  const qc = useQueryClient();
  const restoring = useIsRestoring();
  const t = useT(strings);
  const signOut = useCurrentSessionSignOut();
  useLockOutgoingSession();
  const { token: incomingToken } = useGlobalSearchParams<{
    token?: string | string[];
  }>();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === '/join' && typeof incomingToken === 'string')
      useInviteIntent.getState().setToken(incomingToken);
  }, [incomingToken, pathname]);
  const bridgeUser = useSyncExternalStore(
    subscribeAuthBridge,
    bridgeUserId,
    serverBridgeUserId,
  );
  const hydrated = useCurrentStore((s) => s.hydrated);
  const me = useMe(isSignedIn && bridgeUser === userId);
  const storedId = useCurrentStore((s) =>
    userId ? s.storeIds[userId] : undefined,
  );
  const membership = resolveMembership(me.data?.memberships ?? [], storedId);
  const identity = `${userId ?? ''}:${membership?.store.id ?? ''}`;
  const previous = useRef<string | undefined>(undefined);
  const previousUser = useRef<string | null>(null);
  const [settledIdentity, setSettledIdentity] = useState<string>();

  useLayoutEffect(() => {
    const unregister = registerAuthBridge({
      userId,
      // Locked: Clerk still has an active session (clerk-js picks one by itself on a cold start),
      // but nobody was let in, so no request may carry that person token.
      getToken: locked ? noToken : getToken,
      getStoreId: () => {
        if (!userId) return null;
        const data = qc.getQueryData<Me>(keys.me(userId));
        return (
          resolveMembership(
            data?.memberships ?? [],
            useCurrentStore.getState().storeIds[userId],
          )?.store.id ?? null
        );
      },
      membershipRequired: () => {
        void qc.invalidateQueries({ queryKey: keys.me(userId) });
      },
      // The server locked this session: back to the person picker, which asks for the PIN.
      pinRequired: () => useDeviceLock.getState().lock(),
    });
    return unregister;
  }, [getToken, locked, userId, qc]);

  // Clerk has nobody active but others stay signed in: the phone goes to the person picker and
  // stays locked there, also across a restart. With nobody signed in any more there is nobody to
  // protect, so a stale lock is dropped. Only two moments lock: the cold start (what clerk-js
  // found when it loaded) and losing a session this runtime had seen active. A session that
  // joins the client a moment before it becomes active (a sign-in finishing outside our screens,
  // as @clerk/testing does) has neither: that transient gap must not lock the phone for good.
  const decided = useRef(false);
  const wasActive = useRef(false);
  useEffect(() => {
    if (!isLoaded || !sessionsLoaded || !lockHydrated) return;
    if (auth.isSignedIn) {
      decided.current = true;
      wasActive.current = true;
      return;
    }
    const coldStart = !decided.current;
    decided.current = true;
    const lock = useDeviceLock.getState();
    if (signedInCount > 0 && !lock.locked && (coldStart || wasActive.current))
      lock.lock();
    else if (signedInCount === 0 && lock.locked) lock.unlock();
  }, [isLoaded, sessionsLoaded, lockHydrated, auth.isSignedIn, signedInCount]);

  // A different person or store must never inherit cached shop data, a cart, alerts, camera or
  // quick-enroll state, and a different person not even a pending invite.
  useLayoutEffect(() => {
    if (!isLoaded || !hydrated || restoring || previous.current === identity)
      return;
    const first = previous.current === undefined;
    previous.current = identity;
    // On the first pass `me` is a copy restored from the device, not yet confirmed by the server:
    // dropping it makes the gate wait for the answer instead of trusting a copy that can predate
    // the store the person just created.
    const currentMe =
      !first && userId && me.data?.clerk_user_id === userId
        ? me.data
        : undefined;
    // The persisted offline cache (restored before this runs) stays only for the person and store
    // it was saved for; on a cold start the same identity keeps its catalog.
    const keepRestored =
      first && qc.getQueryData(keys.cacheIdentity()) === identity;
    if (!keepRestored) {
      void qc.cancelQueries();
      qc.clear();
      if (currentMe) qc.setQueryData(keys.me(userId), currentMe);
      if (userId && membership) qc.setQueryData(keys.cacheIdentity(), identity);
    }
    resetStoreScopedState();
    if (previousUser.current && previousUser.current !== userId)
      resetPersonScopedState();
    previousUser.current = userId ?? null;
    setSettledIdentity(identity);
  }, [
    isLoaded,
    hydrated,
    restoring,
    identity,
    userId,
    me.data,
    membership,
    qc,
  ]);

  if (
    !isLoaded ||
    !hydrated ||
    !lockHydrated ||
    restoring ||
    bridgeUser !== userId ||
    settledIdentity !== identity ||
    (isSignedIn && !me.data && !me.isError)
  ) {
    return (
      <View testID="auth-loading">
        <ActivityIndicator accessibilityLabel={t('loading')} />
      </View>
    );
  }
  if (isSignedIn && !me.data)
    return (
      <Frame title={t('title')} back={false}>
        <FormError
          message={
            signOut.failed
              ? t('signOutError')
              : t(
                  isApiError(me.error) && me.error.status >= 500
                    ? 'loadServerError'
                    : 'loadError',
                )
          }
        />
        <ActionButton
          label={t('retry')}
          onPress={() => {
            void me.refetch();
          }}
        />
        <ActionButton
          testID="auth-load-sign-out"
          label={t('signOut')}
          variant="secondary"
          busy={signOut.busy}
          onPress={() => {
            void signOut.signOut();
          }}
        />
      </Frame>
    );
  // `signedIn` follows the *active* Clerk session that the lock lets in. After "Đăng xuất" Clerk
  // has none even when other people are still signed in on this phone, so the gate keeps sending
  // to /sign-in, which lists them and asks for their PIN before activating one.
  return children({
    signedIn: !!isSignedIn,
    hasMembership: !!isSignedIn && membership !== null,
  });
}
