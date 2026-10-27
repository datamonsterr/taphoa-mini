import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';

import { AuthGate } from '@/features/auth/AuthGate';
import { useAddPerson } from '@/features/auth/addPerson';
import { setApiTransport } from '@/lib/api/client';
import { keys } from '@/lib/api/keys';
import * as storeApi from '@/lib/api/store';
import { useCartStore } from '@/stores/cart';
import { useChromeStore } from '@/stores/chrome';
import { useCurrentStore } from '@/stores/currentStore';
import { useDeviceLock } from '@/stores/deviceLock';
import { useSettingsStore } from '@/stores/settings';
import { addClerkSession, clerkMock, getClerkState } from '@/test/clerk';
import { createMockFetch } from '@/test/mock/fetch';
import { buildMe, installPeople, type PersonScript } from '@/test/people';
import { createTestQueryClient, renderWithProviders } from '@/test/render';
import { testSession } from '@/test/session';

import { AccountScreen } from './AccountScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useGlobalSearchParams: () => ({}),
  usePathname: () => '/',
}));

afterEach(() => jest.restoreAllMocks());
beforeEach(() => mockPush.mockClear());

const UT_PIN = '4821';
/** Bé Út has a PIN, hai (no profile name) has none; both are signed in on this phone. */
function crowd(extra: Record<string, PersonScript> = {}) {
  addClerkSession({
    id: 'sess_ut',
    userId: 'user_ut',
    email: 'ut@example.com',
  });
  addClerkSession({
    id: 'sess_hai',
    userId: 'user_hai',
    email: 'hai@example.com',
  });
  return installPeople({
    token_sess_ut: {
      me: buildMe({
        userId: 'user_ut',
        name: 'Bé Út',
        memberships: [{ storeId: 'store_ut', hasPin: true }],
      }),
      pin: UT_PIN,
    },
    token_sess_hai: {
      me: buildMe({
        userId: 'user_hai',
        name: null,
        memberships: [{ storeId: 'store_hai', memberName: 'Anh Hai' }],
      }),
    },
    ...extra,
  });
}

const open = async () => {
  await renderWithProviders(<AccountScreen />);
  return screen.findByRole('header', { name: 'Tạp hóa Cô Ba' });
};
const row = (index: number) => screen.getByTestId(`account-session-${index}`);
const type = async (digits: string) => {
  for (const digit of digits)
    await fireEvent.press(screen.getByRole('button', { name: digit }));
};
const submitPin = async (digits: string, confirm = 'Xác nhận') => {
  await type(digits);
  await fireEvent.press(screen.getByRole('button', { name: confirm }));
};
const openPinFor = async (index: number) => {
  await open();
  await fireEvent.press(row(index));
  await screen.findByTestId('account-switch-pin');
};
const lockout = (retryAfter?: string) =>
  Response.json(
    { error: 'rate limit exceeded', code: 'too_many_requests' },
    {
      status: 429,
      headers: retryAfter ? { 'Retry-After': retryAfter } : undefined,
    },
  );

describe('people on this device', () => {
  test('lists every signed-in person with a name and marks the current one', async () => {
    crowd();
    await open();
    expect(
      screen.getByRole('header', { name: 'Người dùng trên máy này' }),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('account-sessions')).toBeOnTheScreen();
    expect(within(row(0)).getByText('Cô Ba')).toBeOnTheScreen();
    expect(within(row(0)).getByText('Hiện tại')).toBeOnTheScreen();
    expect(row(0)).toBeSelected();
    expect(await within(row(1)).findByText('Bé Út')).toBeOnTheScreen();
    expect(within(row(1)).queryByText('Hiện tại')).toBeNull();
    expect(row(1)).not.toBeSelected();
    // No name in /v1/me: the Clerk user's email stands in.
    expect(await within(row(2)).findByText('Anh Hai')).toBeOnTheScreen();
    expect(screen.queryByTestId('account-session-3')).toBeNull();
  });

  test('skips sessions that are no longer signed in', async () => {
    crowd();
    addClerkSession({
      id: 'sess_old',
      userId: 'user_old',
      email: 'old@example.com',
      status: 'ended',
    });
    await open();
    expect(screen.queryByText('old@example.com')).toBeNull();
    expect(screen.queryByTestId('account-session-3')).toBeNull();
  });

  test('shows the email when the person cannot be loaded', async () => {
    const people = crowd({
      token_sess_ut: { me: new Response('boom', { status: 500 }) },
    });
    await open();
    expect(await within(row(1)).findByText('ut@example.com')).toBeOnTheScreen();
    await waitFor(() => expect(people.mes().length).toBeGreaterThan(0));
  });

  test('falls back to a generic label when Clerk knows no email either', async () => {
    addClerkSession({ id: 'sess_x', userId: 'user_x', email: null });
    installPeople({
      token_sess_x: {
        me: buildMe({ userId: 'user_x', name: null, memberships: [] }),
      },
    });
    await open();
    expect(await within(row(1)).findByText('Người dùng')).toBeOnTheScreen();
  });

  test("reads each other person once, with that person's own token", async () => {
    const people = crowd();
    await open();
    await within(row(1)).findByText('Bé Út');
    await within(row(2)).findByText('Anh Hai');
    expect(people.mes().map(({ token }) => token)).toEqual(
      expect.arrayContaining(['token_sess_ut', 'token_sess_hai']),
    );
    expect(people.mes()).toHaveLength(2);
    expect(
      people.requests.some(({ token }) => token === 'test-clerk-token'),
    ).toBe(false);
  });

  test('speaks English too', async () => {
    crowd();
    useSettingsStore.setState({ language: 'en' });
    await open();
    expect(
      screen.getByRole('header', { name: 'People on this device' }),
    ).toBeOnTheScreen();
    expect(within(row(0)).getByText('Current')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Add a person on this device' }),
    ).toBeOnTheScreen();
  });

  test('tapping the current person does nothing', async () => {
    const people = crowd();
    await open();
    await fireEvent.press(row(0));
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(screen.queryByTestId('account-switch-pin')).toBeNull();
    expect(people.verifies()).toHaveLength(0);
  });
});

describe('switching person', () => {
  test('a person without a PIN becomes active straight away', async () => {
    const people = crowd();
    await open();
    await fireEvent.press(row(2));
    await waitFor(() =>
      expect(clerkMock.setActive).toHaveBeenCalledWith(
        expect.objectContaining({ session: 'sess_hai' }),
      ),
    );
    expect(people.verifies()).toHaveLength(0);
    expect(screen.queryByTestId('account-switch-pin')).toBeNull();
    expect(getClerkState()).toMatchObject({
      userId: 'user_hai',
      sessionId: 'sess_hai',
    });
  });

  test('a person without any store switches straight away', async () => {
    addClerkSession({
      id: 'sess_new',
      userId: 'user_new',
      email: 'new@example.com',
    });
    installPeople({
      token_sess_new: {
        me: buildMe({ userId: 'user_new', name: 'Mới', memberships: [] }),
      },
    });
    await open();
    await fireEvent.press(row(1));
    await waitFor(() =>
      expect(clerkMock.setActive).toHaveBeenCalledWith(
        expect.objectContaining({ session: 'sess_new' }),
      ),
    );
  });

  test('a person with a PIN is asked for it, and setActive follows only a 204', async () => {
    const people = crowd();
    const verifiedBeforeActivation: number[] = [];
    clerkMock.setActive.mockImplementation(async () => {
      verifiedBeforeActivation.push(people.verifies().length);
    });
    await openPinFor(1);
    expect(
      screen.getByRole('header', { name: 'Mã PIN của Bé Út' }),
    ).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    await submitPin(UT_PIN);
    await waitFor(() => expect(clerkMock.setActive).toHaveBeenCalledTimes(1));
    expect(clerkMock.setActive).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'sess_ut' }),
    );
    expect(verifiedBeforeActivation).toEqual([1]);
    await waitFor(() =>
      expect(screen.queryByTestId('account-switch-pin')).toBeNull(),
    );
  });

  test("the PIN check carries the target's token and store, not the active session's", async () => {
    const people = crowd();
    await openPinFor(1);
    await submitPin(UT_PIN);
    await waitFor(() => expect(people.verifies()).toHaveLength(1));
    expect(people.verifies()[0]).toEqual({
      method: 'POST',
      path: '/v1/me/pin/verify',
      token: 'token_sess_ut',
      storeId: 'store_ut',
      body: { pin: UT_PIN },
    });
  });

  test('verifies against the store that person last selected', async () => {
    const people = crowd({
      token_sess_ut: {
        me: buildMe({
          userId: 'user_ut',
          name: 'Bé Út',
          memberships: [
            { storeId: 'store_ut', hasPin: false },
            { storeId: 'store_ut_2', hasPin: true },
          ],
        }),
        pin: UT_PIN,
      },
    });
    useCurrentStore.getState().selectStore('user_ut', 'store_ut_2');
    await openPinFor(1);
    await submitPin(UT_PIN);
    await waitFor(() => expect(people.verifies()).toHaveLength(1));
    expect(people.verifies()[0]!.storeId).toBe('store_ut_2');
  });

  test('without a remembered store the first membership decides', async () => {
    const people = crowd({
      token_sess_ut: {
        me: buildMe({
          userId: 'user_ut',
          name: 'Bé Út',
          memberships: [
            { storeId: 'store_ut', hasPin: true },
            { storeId: 'store_ut_2', hasPin: false },
          ],
        }),
        pin: UT_PIN,
      },
    });
    await openPinFor(1);
    await submitPin(UT_PIN);
    await waitFor(() => expect(people.verifies()[0]?.storeId).toBe('store_ut'));
  });

  test('a PIN in a store the person did not select still guards them, and that store is verified', async () => {
    const people = crowd({
      token_sess_ut: {
        me: buildMe({
          userId: 'user_ut',
          name: 'Bé Út',
          memberships: [
            { storeId: 'store_ut', hasPin: true },
            { storeId: 'store_ut_2', hasPin: false },
          ],
        }),
        pin: UT_PIN,
      },
    });
    useCurrentStore.getState().selectStore('user_ut', 'store_ut_2');
    await openPinFor(1);
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    await submitPin(UT_PIN);
    await waitFor(() => expect(clerkMock.setActive).toHaveBeenCalledTimes(1));
    expect(people.verifies()).toHaveLength(1);
    expect(people.verifies()[0]!.storeId).toBe('store_ut');
  });

  test('a wrong PIN says so, stays on the sheet, clears the digits and never activates', async () => {
    const people = crowd();
    await openPinFor(1);
    await submitPin('0000');
    expect(await screen.findByText('Sai mã PIN')).toBeOnTheScreen();
    expect(screen.getByTestId('account-switch-pin-error')).toHaveTextContent(
      'Sai mã PIN',
    );
    expect(screen.getByLabelText('0 chữ số đã nhập')).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(people.verifies()).toHaveLength(1);
    // The right PIN afterwards still works.
    await submitPin(UT_PIN);
    await waitFor(() => expect(clerkMock.setActive).toHaveBeenCalledTimes(1));
    expect(people.verifies()).toHaveLength(2);
  });

  test.each([
    ['300', 'Thử sai quá nhiều lần. Thử lại sau 5 phút.'],
    ['45', 'Thử sai quá nhiều lần. Thử lại sau 45 giây.'],
    ['61', 'Thử sai quá nhiều lần. Thử lại sau 2 phút.'],
    [undefined, 'Thử sai quá nhiều lần. Vui lòng thử lại sau.'],
  ])(
    'a lockout (Retry-After %s) shows the wait and never activates',
    async (retryAfter, message) => {
      crowd({
        token_sess_ut: {
          me: buildMe({
            userId: 'user_ut',
            name: 'Bé Út',
            memberships: [{ storeId: 'store_ut', hasPin: true }],
          }),
          verify: () => lockout(retryAfter),
        },
      });
      await openPinFor(1);
      await submitPin(UT_PIN);
      expect(await screen.findByText(message)).toBeOnTheScreen();
      expect(clerkMock.setActive).not.toHaveBeenCalled();
      expect(screen.getByTestId('account-switch-pin')).toBeOnTheScreen();
    },
  );

  test('English lockout says how long to wait', async () => {
    useSettingsStore.setState({ language: 'en' });
    crowd({
      token_sess_ut: {
        me: buildMe({
          userId: 'user_ut',
          name: 'Bé Út',
          memberships: [{ storeId: 'store_ut', hasPin: true }],
        }),
        verify: () => lockout('300'),
      },
    });
    await open();
    await fireEvent.press(row(1));
    await screen.findByTestId('account-switch-pin');
    await submitPin(UT_PIN, 'Confirm');
    expect(
      await screen.findByText('Too many attempts. Try again in 5 min.'),
    ).toBeOnTheScreen();
  });

  test.each([
    ['a server error', () => new Response('boom', { status: 500 })],
    ['a missing session', () => new Response(null, { status: 403 })],
  ])(
    '%s while checking the PIN neither switches nor blames the PIN',
    async (_name, verify) => {
      crowd({
        token_sess_ut: {
          me: buildMe({
            userId: 'user_ut',
            name: 'Bé Út',
            memberships: [{ storeId: 'store_ut', hasPin: true }],
          }),
          verify,
        },
      });
      await openPinFor(1);
      await submitPin(UT_PIN);
      expect(
        await screen.findByText(
          'Không kiểm tra được mã PIN. Vui lòng thử lại.',
        ),
      ).toBeOnTheScreen();
      expect(screen.queryByText('Sai mã PIN')).toBeNull();
      expect(clerkMock.setActive).not.toHaveBeenCalled();
    },
  );

  test('an offline PIN check shows the same retry message', async () => {
    const people = crowd();
    await openPinFor(1);
    people.spy.mockRejectedValueOnce(new TypeError('offline'));
    await submitPin(UT_PIN);
    expect(
      await screen.findByText('Không kiểm tra được mã PIN. Vui lòng thử lại.'),
    ).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
  });

  test('closing the sheet keeps the current person and activates nobody', async () => {
    const people = crowd();
    await openPinFor(1);
    await fireEvent.press(screen.getByTestId('sheet-scrim'));
    expect(screen.queryByTestId('account-switch-pin')).toBeNull();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(people.verifies()).toHaveLength(0);
    expect(getClerkState().sessionId).toBe('sess_test');
  });

  test('a PIN set after the list loaded still applies: has_pin is read fresh on tap', async () => {
    const people = crowd();
    await open();
    await within(row(2)).findByText('Anh Hai');
    people.spy.mockClear();
    // hai set a PIN on another phone after this list was cached.
    const latest = buildMe({
      userId: 'user_hai',
      name: null,
      memberships: [
        { storeId: 'store_hai', memberName: 'Anh Hai', hasPin: true },
      ],
    });
    people.spy.mockImplementationOnce(async () => Response.json(latest));
    await fireEvent.press(row(2));
    expect(await screen.findByTestId('account-switch-pin')).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
  });

  test('without knowing whether a PIN exists nobody is switched', async () => {
    const people = crowd();
    await open();
    await within(row(2)).findByText('Anh Hai');
    people.spy.mockImplementationOnce(
      async () => new Response('x', { status: 500 }),
    );
    await fireEvent.press(row(2));
    expect(
      await screen.findByText(
        'Không chuyển được người dùng. Vui lòng thử lại.',
      ),
    ).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    // Trying again works once the network does.
    await fireEvent.press(row(2));
    await waitFor(() => expect(clerkMock.setActive).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.queryByText('Không chuyển được người dùng. Vui lòng thử lại.'),
      ).toBeNull(),
    );
  });

  test('a failed activation after a good PIN shows the switch error', async () => {
    crowd();
    clerkMock.setActive.mockRejectedValueOnce(new Error('offline'));
    await openPinFor(1);
    await submitPin(UT_PIN);
    expect(
      await screen.findByText(
        'Không chuyển được người dùng. Vui lòng thử lại.',
      ),
    ).toBeOnTheScreen();
    expect(getClerkState().sessionId).toBe('sess_test');
  });

  test('a person with a PIN can only be reached through it, even with several taps', async () => {
    const people = crowd();
    await open();
    await fireEvent.press(row(1));
    await screen.findByTestId('account-switch-pin');
    await fireEvent.press(row(1));
    await fireEvent.press(row(2));
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(people.verifies()).toHaveLength(0);
  });
});

describe('after switching', () => {
  const me = (userId: string) => ({
    clerk_user_id: userId,
    profile: null,
    memberships: [testSession()],
  });

  test('the previous person keeps no cached shop data, cart or alerts', async () => {
    crowd();
    const mock = createMockFetch();
    setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return new URL(request.url).pathname === '/v1/me'
        ? Response.json(me(getClerkState().userId ?? 'user_test'))
        : mock(request);
    }) as typeof fetch);
    const qc = createTestQueryClient();
    await renderWithProviders(
      <AuthGate>{() => <AccountScreen />}</AuthGate>,
      qc,
    );
    await screen.findByRole('header', { name: 'Tạp hóa Cô Ba' });
    qc.setQueryData(['private-shop-data'], 'cô Ba secrets');
    useCartStore.getState().add({ productId: 'p', name: 'Milk', price: 10 });
    await fireEvent.press(row(2));
    await waitFor(() => expect(getClerkState().userId).toBe('user_hai'));
    await waitFor(() =>
      expect(qc.getQueryData(['private-shop-data'])).toBeUndefined(),
    );
    expect(useCartStore.getState().lines).toEqual([]);
    expect(qc.getQueryData(keys.me('user_test'))).toBeUndefined();
    expect(
      await screen.findByRole('header', { name: 'Tạp hóa Cô Ba' }),
    ).toBeOnTheScreen();
    expect(within(row(2)).getByText('Hiện tại')).toBeOnTheScreen();
  });
});

describe('sign out', () => {
  test('removes only the current session', async () => {
    crowd();
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
    expect(clerkMock.signOut).toHaveBeenCalledTimes(1);
    expect(clerkMock.signOut).toHaveBeenCalledWith({ sessionId: 'sess_test' });
  });

  test('leaves nobody active and never hands the phone to the next person', async () => {
    crowd();
    addClerkSession({
      id: 'sess_old',
      userId: 'user_old',
      email: 'old@example.com',
      status: 'ended',
    });
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
    await waitFor(() => expect(getClerkState().isSignedIn).toBe(false));
    // Let everything the hook does after signOut settle before looking.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(getClerkState()).toMatchObject({
      isSignedIn: false,
      userId: null,
      sessionId: null,
    });
    // Their PIN guards them: nobody is activated without it.
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    // And the lock holds the phone on the person picker, even across a restart.
    expect(useDeviceLock.getState().locked).toBe(true);
    // The others stay signed in on the device, to be picked on the sign-in screen.
    expect(
      clerkMock.sessions.filter(({ status }) => status === 'active'),
    ).toHaveLength(2);
  });

  test('the last person signs out of the app and activates nobody', async () => {
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
    await waitFor(() => expect(getClerkState().isSignedIn).toBe(false));
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    // Nobody else is signed in, so there is nobody to protect: a plain sign-in screen.
    expect(useDeviceLock.getState().locked).toBe(false);
  });

  test('a failed sign-out leaves everyone as they were', async () => {
    crowd();
    clerkMock.signOut.mockRejectedValueOnce(new Error('offline'));
    await open();
    await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
    expect(
      await screen.findByText('Không đăng xuất được. Vui lòng thử lại.'),
    ).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(useDeviceLock.getState().locked).toBe(false);
  });
});

describe('adding a person', () => {
  test('opens the add-person route without signing anyone out', async () => {
    crowd();
    await open();
    await fireEvent.press(screen.getByTestId('account-add-person'));
    expect(mockPush).toHaveBeenCalledWith('/add-person');
    expect(useAddPerson.getState().from).toBe('sess_test');
    expect(clerkMock.signOut).not.toHaveBeenCalled();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(getClerkState().sessionId).toBe('sess_test');
  });

  test('is offered even when this phone has one person only', async () => {
    await open();
    expect(
      screen.getByRole('button', { name: 'Thêm người trên máy này' }),
    ).toBeOnTheScreen();
  });
});

describe('store picker', () => {
  const twoStores = async () => {
    const first = testSession();
    const second = {
      store: { ...first.store, id: 'store_two', name: 'Tạp hóa Chú Tư' },
      member: { ...first.member, role: 'seller' as const },
    };
    jest.spyOn(storeApi, 'getMe').mockResolvedValue({
      clerk_user_id: 'user_test',
      profile: null,
      memberships: [first, second],
    });
    return { first, second };
  };

  test('is hidden with a single store', async () => {
    await open();
    expect(screen.queryByText('Cửa hàng')).toBeNull();
    expect(screen.queryByTestId(/^account-store-/)).toBeNull();
  });

  test('lists every store of the current person and marks the selected one', async () => {
    const { first, second } = await twoStores();
    await open();
    expect(screen.getByRole('header', { name: 'Cửa hàng' })).toBeOnTheScreen();
    const a = screen.getByTestId(`account-store-${first.store.id}`);
    const b = screen.getByTestId(`account-store-${second.store.id}`);
    expect(within(a).getByText('Tạp hóa Cô Ba')).toBeOnTheScreen();
    expect(within(b).getByText('Tạp hóa Chú Tư')).toBeOnTheScreen();
    expect(a).toBeChecked();
    expect(b).not.toBeChecked();
  });

  test("choosing a store updates the current store for that Clerk user and the next request's X-Store-Id", async () => {
    const { second } = await twoStores();
    const sent: (string | null)[] = [];
    const mock = createMockFetch();
    setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push(request.headers.get('x-store-id'));
      return mock(request);
    }) as typeof fetch);
    await open();
    await fireEvent.press(
      screen.getByTestId(`account-store-${second.store.id}`),
    );
    expect(useCurrentStore.getState().storeIds.user_test).toBe(second.store.id);
    expect(
      screen.getByTestId(`account-store-${second.store.id}`),
    ).toBeChecked();
    sent.length = 0;
    await storeApi.getStore();
    expect(sent).toEqual([second.store.id]);
  });

  test('choosing a store clears shop data, the cart and alerts', async () => {
    const { second } = await twoStores();
    const qc = createTestQueryClient();
    await renderWithProviders(
      <AuthGate>{() => <AccountScreen />}</AuthGate>,
      qc,
    );
    await screen.findByRole('header', { name: 'Tạp hóa Cô Ba' });
    qc.setQueryData(['private-shop-data'], 'first store secret');
    useCartStore.getState().add({ productId: 'p', name: 'Milk', price: 10 });
    await fireEvent.press(
      screen.getByTestId(`account-store-${second.store.id}`),
    );
    await waitFor(() =>
      expect(qc.getQueryData(['private-shop-data'])).toBeUndefined(),
    );
    expect(useCartStore.getState().lines).toEqual([]);
  });

  test('picking the selected store again changes nothing', async () => {
    const { first } = await twoStores();
    await open();
    await fireEvent.press(
      screen.getByTestId(`account-store-${first.store.id}`),
    );
    expect(useCurrentStore.getState().storeIds).toEqual({});
  });
});

test('every sheet that hides the tab bar restores it', async () => {
  crowd();
  await openPinFor(1);
  expect(useChromeStore.getState().tabBarHidden).toBe(true);
  await fireEvent.press(screen.getByTestId('sheet-scrim'));
  expect(useChromeStore.getState().tabBarHidden).toBe(false);
});
