import { act, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { Text } from 'react-native';
import { AuthGate } from './AuthGate';
import { renderWithProviders, createTestQueryClient } from '@/test/render';
import { useCurrentStore } from '@/stores/currentStore';
import { useCartStore } from '@/stores/cart';
import { useLowStockAlerts } from '@/stores/lowStockAlerts';
import { keys } from '@/lib/api/keys';
import { setClerkState } from '@/test/clerk';
import { setApiTransport } from '@/lib/api/client';
import { membershipRequired } from '@/lib/api/clerkBridge';
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
