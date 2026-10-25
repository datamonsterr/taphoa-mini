import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
} from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { Text } from 'react-native';
import { AuthGate } from './AuthGate';
import { renderWithProviders, createTestQueryClient } from '@/test/render';
import { useCurrentStore } from '@/stores/currentStore';
import { useCartStore } from '@/stores/cart';
import { useLowStockAlerts } from '@/stores/lowStockAlerts';
import { keys } from '@/lib/api/keys';
import { addClerkSession, clerkMock, setClerkState } from '@/test/clerk';
import { useDeviceLock } from '@/stores/deviceLock';
import { setApiTransport } from '@/lib/api/client';
import { bridgeUserId, membershipRequired } from '@/lib/api/clerkBridge';
import { testSession } from '@/test/session';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn() }),
  useGlobalSearchParams: () => ({}),
  usePathname: () => '/',
}));

const gate = (
  <AuthGate>
    {({ signedIn, hasMembership }) => (
      <Text>
        {!signedIn ? 'signed-out' : hasMembership ? 'shop' : 'onboarding'}
      </Text>
    )}
  </AuthGate>
);

test('changing the selected store clears query data, cart and low-stock alerts', async () => {
  const first = testSession();
  const second = {
    store: { ...first.store, id: 'second-store' },
    member: { ...first.member, role: 'seller' as const, can_enroll: false },
  };
  const me = {
    clerk_user_id: 'user_test',
    profile: null,
    memberships: [first, second],
  };
  setApiTransport((async () => Response.json(me)) as typeof fetch);
  const qc = createTestQueryClient();
  await renderWithProviders(gate, qc);
  await screen.findByText('shop');
  qc.setQueryData(['private-shop-data'], 'first-store-secret');
  useCartStore.getState().add({ productId: 'p', name: 'Milk', price: 10 });
  useLowStockAlerts.getState().push({
    product_id: 'p',
    name: 'Milk',
    stock_quantity: 1,
    threshold: 5,
    at: '2026-10-25',
  });
  await act(async () =>
    useCurrentStore.getState().selectStore('user_test', second.store.id),
  );
  expect(await screen.findByText('shop')).toBeOnTheScreen();
  expect(qc.getQueryData(['private-shop-data'])).toBeUndefined();
  expect(useCartStore.getState().lines).toEqual([]);
  expect(useLowStockAlerts.getState().seenProductIds).toEqual([]);
  expect(qc.getQueryData(keys.me('user_test'))).toEqual(me);
});

test('changing Clerk users and signing out clear the previous user data', async () => {
  let userId = 'user_test';
  setApiTransport((async () =>
    Response.json({
      clerk_user_id: userId,
      profile: null,
      memberships: [testSession()],
    })) as typeof fetch);
  const qc = createTestQueryClient();
  await renderWithProviders(gate, qc);
  await screen.findByText('shop');
  qc.setQueryData(['private'], 'previous-person');
  userId = 'user_other';
  await act(async () => setClerkState({ userId, sessionId: 'sess_other' }));
  await screen.findByText('shop');
  expect(qc.getQueryData(keys.me('user_test'))).toBeUndefined();
  expect(qc.getQueryData(['private'])).toBeUndefined();
  useCartStore.getState().add({ productId: 'p', name: 'Milk', price: 10 });
  await act(async () =>
    setClerkState({ isSignedIn: false, userId: null, sessionId: null }),
  );
  expect(await screen.findByText('signed-out')).toBeOnTheScreen();
  expect(useCartStore.getState().lines).toEqual([]);
});

test('membership_required refetches me and the gate leaves the shop', async () => {
  let memberships = [testSession()];
  setApiTransport((async () =>
    Response.json({
      clerk_user_id: 'user_test',
      profile: null,
      memberships,
    })) as typeof fetch);
  const qc = createTestQueryClient();
  await renderWithProviders(gate, qc);
  await screen.findByText('shop');
  memberships = [];
  await act(async () => membershipRequired());
  await waitFor(() => expect(screen.getByText('onboarding')).toBeOnTheScreen());
});

test('me failure offers retry and only then resolves the onboarding gate', async () => {
  const qc = createTestQueryClient();
  let fail = true;
  setApiTransport((async () =>
    fail
      ? Response.json({ error: 'unavailable' }, { status: 503 })
      : Response.json({
          clerk_user_id: 'user_test',
          profile: null,
          memberships: [],
        })) as typeof fetch);
  await renderWithProviders(gate, qc);
  expect(
    await screen.findByText(
      'Không tải được tài khoản. Kiểm tra mạng rồi thử lại.',
    ),
  ).toBeOnTheScreen();
  fail = false;
  await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
  expect(await screen.findByText('onboarding')).toBeOnTheScreen();
});

describe('device lock', () => {
  /** The gate without the helper that prefetches the signed-in me. */
  const mount = () =>
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        {gate}
      </QueryClientProvider>,
    );
  const otherPerson = () =>
    addClerkSession({
      id: 'sess_ut',
      userId: 'user_ut',
      email: 'ut@example.com',
    });

  test('an active session is not let in while locked, and is not even read', async () => {
    const seen: string[] = [];
    setApiTransport((async (input: RequestInfo | URL) => {
      seen.push(new URL(new Request(input).url).pathname);
      return Response.json({
        clerk_user_id: 'user_test',
        profile: null,
        memberships: [testSession()],
      });
    }) as typeof fetch);
    useDeviceLock.getState().lock();
    await mount();
    expect(await screen.findByText('signed-out')).toBeOnTheScreen();
    expect(seen).toEqual([]);
    expect(bridgeUserId()).toBeNull();
    // Picking a person lifts the lock: only then is the session read and let in.
    await act(async () => useDeviceLock.getState().unlock());
    expect(await screen.findByText('shop')).toBeOnTheScreen();
    expect(seen).toContain('/v1/me');
    expect(bridgeUserId()).toBe('user_test');
  });

  test('locking while signed in sends the person out of the shop at once', async () => {
    await mount();
    await screen.findByText('shop');
    await act(async () => useDeviceLock.getState().lock());
    expect(await screen.findByText('signed-out')).toBeOnTheScreen();
  });

  test('waits for the stored lock before deciding anything', async () => {
    useDeviceLock.setState({ hydrated: false });
    await mount();
    expect(await screen.findByTestId('auth-loading')).toBeOnTheScreen();
    expect(screen.queryByText('shop')).toBeNull();
    await act(async () => useDeviceLock.setState({ hydrated: true }));
    expect(await screen.findByText('shop')).toBeOnTheScreen();
  });

  test('locks as soon as Clerk has nobody active while others stay signed in', async () => {
    otherPerson();
    await clerkMock.signOut({ sessionId: 'sess_test' });
    await mount();
    expect(await screen.findByText('signed-out')).toBeOnTheScreen();
    await waitFor(() => expect(useDeviceLock.getState().locked).toBe(true));
  });

  test('losing the active session mid-use locks the phone too', async () => {
    otherPerson();
    await mount();
    await screen.findByText('shop');
    expect(useDeviceLock.getState().locked).toBe(false);
    await act(async () => clerkMock.signOut({ sessionId: 'sess_test' }));
    expect(await screen.findByText('signed-out')).toBeOnTheScreen();
    await waitFor(() => expect(useDeviceLock.getState().locked).toBe(true));
  });

  test('does not lock when nobody else is signed in', async () => {
    await clerkMock.signOut({ sessionId: 'sess_test' });
    await mount();
    expect(await screen.findByText('signed-out')).toBeOnTheScreen();
    expect(useDeviceLock.getState().locked).toBe(false);
  });

  test('ended and pending sessions are not people to protect', async () => {
    await clerkMock.signOut({ sessionId: 'sess_test' });
    addClerkSession({
      id: 'sess_old',
      userId: 'user_old',
      email: 'old@example.com',
      status: 'ended',
    });
    addClerkSession({
      id: 'sess_wait',
      userId: 'user_wait',
      email: 'wait@example.com',
      status: 'pending',
    });
    await mount();
    expect(await screen.findByText('signed-out')).toBeOnTheScreen();
    expect(useDeviceLock.getState().locked).toBe(false);
  });

  test('does not lock a signed-in phone', async () => {
    otherPerson();
    await mount();
    expect(await screen.findByText('shop')).toBeOnTheScreen();
    expect(useDeviceLock.getState().locked).toBe(false);
  });

  test('a stale lock with nobody signed in at all is dropped, not a trap', async () => {
    await clerkMock.signOut({ sessionId: 'sess_test' });
    useDeviceLock.getState().lock();
    await mount();
    expect(await screen.findByText('signed-out')).toBeOnTheScreen();
    await waitFor(() => expect(useDeviceLock.getState().locked).toBe(false));
  });

  test('a lock stays while somebody is still signed in', async () => {
    otherPerson();
    await clerkMock.signOut({ sessionId: 'sess_test' });
    useDeviceLock.getState().lock();
    await mount();
    expect(await screen.findByText('signed-out')).toBeOnTheScreen();
    expect(useDeviceLock.getState().locked).toBe(true);
  });
});
