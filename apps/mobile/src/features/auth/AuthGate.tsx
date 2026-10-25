import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useInviteIntent } from '@/features/onboarding/inviteIntent';
import { useAuth } from '@clerk/expo';
import { useQueryClient } from '@tanstack/react-query';
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
import { useMe } from '@/lib/api/hooks';
import { keys } from '@/lib/api/keys';
import type { Me } from '@/lib/api/store';
import { useCartStore } from '@/stores/cart';
import { useLowStockAlerts } from '@/stores/lowStockAlerts';
import { resolveMembership, useCurrentStore } from '@/stores/currentStore';
import { useT } from '@/lib/i18n';
import { Frame, FormError, ActionButton } from '@/features/onboarding/kit';
import { strings } from './strings';

type GateState = { signedIn: boolean; hasMembership: boolean };
export function AuthGate({
  children,
}: {
  children: (state: GateState) => ReactNode;
}) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const qc = useQueryClient();
  const t = useT(strings);
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
  const me = useMe(bridgeUser === userId);
  const storedId = useCurrentStore((s) =>
    userId ? s.storeIds[userId] : undefined,
  );
  const membership = resolveMembership(me.data?.memberships ?? [], storedId);
  const identity = `${userId ?? ''}:${membership?.store.id ?? ''}`;
  const previous = useRef<string | undefined>(undefined);
  const [settledIdentity, setSettledIdentity] = useState<string>();

  useLayoutEffect(() => {
    const unregister = registerAuthBridge({
      userId,
      getToken,
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
    });
    return unregister;
  }, [getToken, userId, qc]);

  // A different person or store must never inherit a cart, alerts or cached shop data.
  useLayoutEffect(() => {
    if (!isLoaded || !hydrated || previous.current === identity) return;
    previous.current = identity;
    const currentMe =
      userId && me.data?.clerk_user_id === userId ? me.data : undefined;
    void qc.cancelQueries();
    qc.clear();
    if (currentMe) qc.setQueryData(keys.me(userId), currentMe);
    useCartStore.getState().clear();
    useLowStockAlerts.getState().reset();
    setSettledIdentity(identity);
  }, [isLoaded, hydrated, identity, userId, me.data, qc]);

  if (
    !isLoaded ||
    !hydrated ||
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
        <FormError message={t('loadError')} />
        <ActionButton
          label={t('retry')}
          onPress={() => {
            void me.refetch();
          }}
        />
      </Frame>
    );
  // `signedIn` follows the *active* Clerk session only. After "Đăng xuất" Clerk has none even when
  // other people are still signed in on this phone, so the gate keeps sending to /sign-in, which
  // lists them and asks for their PIN before activating one.
  return children({
    signedIn: !!isSignedIn,
    hasMembership: !!isSignedIn && membership !== null,
  });
}
