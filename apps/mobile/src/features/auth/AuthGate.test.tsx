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
import { useCaptureModeStore } from '@/features/camera/modeStore';
import { useQuickEnrollStore } from '@/features/camera/quickEnroll';
import { useInviteIntent } from '@/features/onboarding/inviteIntent';
import { useReceiptNotice } from '@/features/receipts/ReceiptToast';
import { getApiClient, setApiTransport } from '@/lib/api/client';
import {
  bridgeUserId,
  clerkToken,
  currentStoreId,
  membershipRequired,
} from '@/lib/api/clerkBridge';
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

/** What one person was doing in one store: the camera, a receipt toast, a pending invite. */
function leaveTracesOfAPerson() {
  const quick = useQuickEnrollStore.getState().dispatch;
  quick({ type: 'toggle' });
  quick({
    type: 'captured',
    id: 'shot-1',
    uri: 'file:///private/a.jpg',
    width: 10,
    height: 10,
  });
  quick({ type: 'uploaded', id: 'shot-1', imageId: 'image-of-person-a' });
  useReceiptNotice.setState({ count: 7 });
  useCaptureModeStore.setState({ mode: 'many' });
  useInviteIntent.getState().setToken('INVITE-FOR-A');
  useCartStore.getState().add({ productId: 'p', name: 'Milk', price: 10 });
}
const noTraces = () => {
  expect(useQuickEnrollStore.getState()).toMatchObject({
    active: false,
    shots: [],
    currentId: undefined,
  });
  expect(useReceiptNotice.getState().count).toBeNull();
  expect(useCaptureModeStore.getState().mode).toBe('one');
  expect(useCartStore.getState().lines).toEqual([]);
};

test('a different person inherits no quick-enroll shots, receipt notice, capture mode or invite', async () => {
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
  leaveTracesOfAPerson();
  userId = 'user_other';
  await act(async () => setClerkState({ userId, sessionId: 'sess_other' }));
  await screen.findByText('shop');
  noTraces();
  expect(useInviteIntent.getState().token).toBe('');
});

test('signing out clears them too, and the lock does the same for the picked person', async () => {
  await renderWithProviders(gate);
  await screen.findByText('shop');
  leaveTracesOfAPerson();
  await act(async () => useDeviceLock.getState().lock());
  expect(await screen.findByText('signed-out')).toBeOnTheScreen();
  noTraces();
  expect(useInviteIntent.getState().token).toBe('');
});

test('another store of the same person inherits the camera state, but a pending invite stays', async () => {
  const first = testSession();
  const second = {
    store: { ...first.store, id: 'second-store' },
    member: { ...first.member },
  };
  setApiTransport((async () =>
    Response.json({
      clerk_user_id: 'user_test',
      profile: null,
      memberships: [first, second],
    })) as typeof fetch);
  await renderWithProviders(gate);
  await screen.findByText('shop');
  leaveTracesOfAPerson();
  await act(async () =>
    useCurrentStore.getState().selectStore('user_test', second.store.id),
  );
  await screen.findByText('shop');
  noTraces();
  expect(useInviteIntent.getState().token).toBe('INVITE-FOR-A');
});

test('an invite that arrived before anyone was signed in survives the sign-in', async () => {
  await clerkMock.signOut({ sessionId: 'sess_test' });
  useInviteIntent.getState().setToken('LINK-OPENED-SIGNED-OUT');
  await renderWithProviders(gate);
  await screen.findByText('signed-out');
  await act(async () => {
    addClerkSession({
      id: 'sess_new',
      userId: 'user_test',
      email: 'new@example.com',
    });
    setClerkState({
      isSignedIn: true,
      userId: 'user_test',
      sessionId: 'sess_new',
    });
  });
  await screen.findByText('shop');
  expect(useInviteIntent.getState().token).toBe('LINK-OPENED-SIGNED-OUT');
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

test('a forbidden answer in the selected store re-reads me and falls back to another membership', async () => {
  const first = testSession();
  const second = {
    store: { ...first.store, id: 'second-store' },
    member: { ...first.member },
  };
  let memberships = [first, second];
  setApiTransport((async (input: RequestInfo | URL) =>
    new URL(new Request(input).url).pathname === '/v1/me'
      ? Response.json({
          clerk_user_id: 'user_test',
          profile: null,
          memberships,
        })
      : Response.json(
          { error: 'not a member', code: 'forbidden' },
          { status: 403 },
        )) as typeof fetch);
  await renderWithProviders(gate);
  await screen.findByText('shop');
  await act(async () =>
    useCurrentStore.getState().selectStore('user_test', second.store.id),
  );
  await screen.findByText('shop');
  await waitFor(() => expect(currentStoreId()).toBe(second.store.id));
  // The person was removed from the selected store meanwhile.
  memberships = [first];
  const answer = await getApiClient().raw.GET('/v1/members');
  expect(answer.response.status).toBe(403);
  await waitFor(() => expect(currentStoreId()).toBe(first.store.id));
  expect(await screen.findByText('shop')).toBeOnTheScreen();
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
  // the server answered 503: the network is fine, so the message must not blame it
  expect(
    await screen.findByText(
      'Máy chủ đang bận, chưa tải được tài khoản. Thử lại sau.',
    ),
  ).toBeOnTheScreen();
  fail = false;
  await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
  expect(await screen.findByText('onboarding')).toBeOnTheScreen();
});

test('me failing with a network error blames the network, not the server', async () => {
  setApiTransport((async () => {
    throw new TypeError('Network request failed');
  }) as typeof fetch);
  await renderWithProviders(gate);
  expect(
    await screen.findByText(
      'Không tải được tài khoản. Kiểm tra mạng rồi thử lại.',
    ),
  ).toBeOnTheScreen();
  expect(
    screen.queryByText(
      'Máy chủ đang bận, chưa tải được tài khoản. Thử lại sau.',
    ),
  ).toBeNull();
});

describe('the me error frame', () => {
  const failMe = () =>
    setApiTransport((async () => {
      throw new TypeError('Network request failed');
    }) as typeof fetch);
  const loadError = 'Không tải được tài khoản. Kiểm tra mạng rồi thử lại.';

  test('offers to sign out the current session, so the person can reach sign-in', async () => {
    failMe();
    await renderWithProviders(gate);
    await screen.findByText(loadError);
    await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
    expect(clerkMock.signOut).toHaveBeenCalledTimes(1);
    expect(clerkMock.signOut).toHaveBeenCalledWith({ sessionId: 'sess_test' });
    expect(await screen.findByText('signed-out')).toBeOnTheScreen();
    expect(useDeviceLock.getState().locked).toBe(false);
  });

  test('with other people on the phone it leaves them at the picker, locked', async () => {
    addClerkSession({
      id: 'sess_ut',
      userId: 'user_ut',
      email: 'ut@example.com',
    });
    failMe();
    await renderWithProviders(gate);
    await screen.findByText(loadError);
    await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
    expect(await screen.findByText('signed-out')).toBeOnTheScreen();
    expect(clerkMock.signOut).toHaveBeenCalledWith({ sessionId: 'sess_test' });
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(useDeviceLock.getState().locked).toBe(true);
  });

  test('a failed sign-out says so and keeps both buttons', async () => {
    failMe();
    clerkMock.signOut.mockRejectedValueOnce(new Error('offline'));
    await renderWithProviders(gate);
    await screen.findByText(loadError);
    await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
    expect(
      await screen.findByText('Không đăng xuất được. Vui lòng thử lại.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Đăng xuất' })).toBeOnTheScreen();
  });
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

  test('while locked the bridge hands out no token and no store, not even the live one', async () => {
    useDeviceLock.getState().lock();
    await mount();
    await screen.findByText('signed-out');
    expect(await clerkToken()).toBeNull();
    expect(await clerkToken({ skipCache: true })).toBeNull();
    expect(currentStoreId()).toBeNull();
    expect(clerkMock.getToken).not.toHaveBeenCalled();
    await act(async () => useDeviceLock.getState().unlock());
    await screen.findByText('shop');
    expect(await clerkToken()).toBe('test-clerk-token');
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

  test('a session that becomes active outside our screens does not lock the phone', async () => {
    // @clerk/testing redeems a sign-in ticket in the page: the session joins the client a moment
    // before Clerk makes it the active one.
    setApiTransport((async () =>
      Response.json({
        clerk_user_id: 'user_ut',
        profile: null,
        memberships: [testSession()],
      })) as typeof fetch);
    await clerkMock.signOut({ sessionId: 'sess_test' });
    await mount();
    expect(await screen.findByText('signed-out')).toBeOnTheScreen();
    await act(async () => {
      otherPerson();
    });
    await act(async () => {
      setClerkState({
        isSignedIn: true,
        userId: 'user_ut',
        sessionId: 'sess_ut',
      });
    });
    expect(await screen.findByText('shop')).toBeOnTheScreen();
    expect(useDeviceLock.getState().locked).toBe(false);
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
