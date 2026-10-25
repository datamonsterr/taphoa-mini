import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';

import { useCurrentStore } from '@/stores/currentStore';
import { useDeviceLock } from '@/stores/deviceLock';
import { useSettingsStore } from '@/stores/settings';
import { addClerkSession, clerkMock, getClerkState } from '@/test/clerk';
import { buildMe, installPeople, type PersonScript } from '@/test/people';
import { renderWithProviders } from '@/test/render';

import { SignInScreen } from './SignInScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  Redirect: () => null,
}));

afterEach(() => jest.restoreAllMocks());
beforeEach(() => mockPush.mockClear());

const UT_PIN = '4821';

/**
 * Cô Ba (the default session) signed out on a phone that Bé Út (with a PIN) and hai (none)
 * still have a session on. Clerk then has nobody active.
 */
async function sharedPhone(extra: Record<string, PersonScript> = {}) {
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
  const people = installPeople({
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
        memberships: [{ storeId: 'store_hai' }],
      }),
    },
    ...extra,
  });
  await clerkMock.signOut({ sessionId: 'sess_test' });
  // What the sign-out hook does when others stay signed in.
  useDeviceLock.getState().lock();
  return people;
}

/** The person a finished Google sign-in creates a session for (the mock names her `sess_google`). */
const googlePerson: Record<string, PersonScript> = {
  token_sess_google: {
    me: buildMe({
      userId: 'user_google',
      name: 'Gờ',
      memberships: [{ storeId: 'store_google' }],
    }),
  },
};

const open = (flow?: 'add') =>
  renderWithProviders(<SignInScreen flow={flow} />);
const row = (index: number) =>
  screen.getByTestId(`auth-device-session-${index}`);
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
  await screen.findByTestId('auth-switch-pin');
};
const lockout = () =>
  Response.json(
    { error: 'rate limit exceeded', code: 'too_many_requests' },
    { status: 429, headers: { 'Retry-After': '300' } },
  );

describe('signing out on a shared phone', () => {
  test('lists the people still signed in, next to the email form', async () => {
    await sharedPhone();
    await open();
    expect(screen.getByTestId('auth-sign-in-screen')).toBeOnTheScreen();
    expect(screen.getByTestId('auth-device-sessions')).toBeOnTheScreen();
    expect(
      screen.getByRole('header', { name: 'Chọn người trên máy này' }),
    ).toBeOnTheScreen();
    expect(await within(row(0)).findByText('Bé Út')).toBeOnTheScreen();
    // No name in /v1/me: the Clerk user's email stands in.
    expect(
      await within(row(1)).findByText('hai@example.com'),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('auth-device-session-2')).toBeNull();
    // Nobody is "current" and the person who signed out is not offered.
    expect(screen.queryByText('Hiện tại')).toBeNull();
    expect(screen.queryByText('coba@example.com')).toBeNull();
    // The normal form for another email is still there.
    expect(screen.getByTestId('auth-email')).toBeOnTheScreen();
    expect(screen.getByTestId('auth-send-code')).toBeOnTheScreen();
    expect(screen.getByTestId('auth-google')).toBeOnTheScreen();
    expect(
      screen.getByText('Hoặc đăng nhập bằng email khác'),
    ).toBeOnTheScreen();
  });

  test("reads each person with that person's own token, never an active session's", async () => {
    const people = await sharedPhone();
    await open();
    await within(row(0)).findByText('Bé Út');
    await within(row(1)).findByText('hai@example.com');
    expect(people.mes().map(({ token }) => token)).toEqual(
      expect.arrayContaining(['token_sess_ut', 'token_sess_hai']),
    );
    expect(people.mes()).toHaveLength(2);
    expect(
      people.requests.some(({ token }) => token === 'test-clerk-token'),
    ).toBe(false);
    expect(getClerkState().sessionId).toBeNull();
  });

  test('is hidden when nobody else is signed in', async () => {
    const people = installPeople({});
    await clerkMock.signOut({ sessionId: 'sess_test' });
    await open();
    expect(screen.getByTestId('auth-email')).toBeOnTheScreen();
    expect(screen.queryByTestId('auth-device-sessions')).toBeNull();
    expect(screen.queryByText('Chọn người trên máy này')).toBeNull();
    expect(screen.queryByText('Hoặc đăng nhập bằng email khác')).toBeNull();
    expect(people.requests).toHaveLength(0);
  });

  test('is hidden when only ended or pending sessions remain', async () => {
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
    const people = installPeople({});
    await clerkMock.signOut({ sessionId: 'sess_test' });
    await open();
    expect(screen.queryByTestId('auth-device-sessions')).toBeNull();
    expect(people.requests).toHaveLength(0);
  });

  test('is not part of adding a person while signed in', async () => {
    addClerkSession({
      id: 'sess_ut',
      userId: 'user_ut',
      email: 'ut@example.com',
    });
    const people = installPeople({});
    await open('add');
    expect(screen.getByTestId('auth-add-cancel')).toBeOnTheScreen();
    expect(screen.queryByTestId('auth-device-sessions')).toBeNull();
    expect(people.requests).toHaveLength(0);
  });

  test('speaks English too', async () => {
    useSettingsStore.setState({ language: 'en' });
    await sharedPhone();
    await open();
    expect(
      screen.getByRole('header', { name: 'Choose a person on this device' }),
    ).toBeOnTheScreen();
    expect(screen.getByText('Or sign in with another email')).toBeOnTheScreen();
    expect(
      await screen.findByRole('button', { name: 'Continue as Bé Út' }),
    ).toBeOnTheScreen();
  });

  test('shows the email when a person cannot be loaded, and a generic label without one', async () => {
    await sharedPhone({
      token_sess_ut: { me: new Response('boom', { status: 500 }) },
    });
    addClerkSession({ id: 'sess_x', userId: 'user_x', email: null });
    await open();
    expect(await within(row(0)).findByText('ut@example.com')).toBeOnTheScreen();
    expect(await within(row(2)).findByText('Người dùng')).toBeOnTheScreen();
  });
});

describe('picking a person', () => {
  test('a person without a PIN becomes active straight away', async () => {
    const people = await sharedPhone();
    await open();
    await fireEvent.press(row(1));
    await waitFor(() =>
      expect(clerkMock.setActive).toHaveBeenCalledWith(
        expect.objectContaining({ session: 'sess_hai' }),
      ),
    );
    expect(clerkMock.setActive).toHaveBeenCalledTimes(1);
    expect(people.verifies()).toHaveLength(0);
    expect(screen.queryByTestId('auth-switch-pin')).toBeNull();
    expect(getClerkState()).toMatchObject({
      isSignedIn: true,
      userId: 'user_hai',
      sessionId: 'sess_hai',
    });
  });

  test('a person with a PIN is asked for it, and setActive follows only a 204', async () => {
    const people = await sharedPhone();
    const verifiedBeforeActivation: number[] = [];
    clerkMock.setActive.mockImplementation(async () => {
      verifiedBeforeActivation.push(people.verifies().length);
    });
    await openPinFor(0);
    expect(
      screen.getByRole('header', { name: 'Mã PIN của Bé Út' }),
    ).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(people.verifies()).toHaveLength(0);
    await submitPin(UT_PIN);
    await waitFor(() => expect(clerkMock.setActive).toHaveBeenCalledTimes(1));
    expect(clerkMock.setActive).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'sess_ut' }),
    );
    expect(verifiedBeforeActivation).toEqual([1]);
    await waitFor(() =>
      expect(screen.queryByTestId('auth-switch-pin')).toBeNull(),
    );
  });

  test("the PIN check carries that person's token and store", async () => {
    const people = await sharedPhone();
    await openPinFor(0);
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
    const people = await sharedPhone({
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
    await openPinFor(0);
    await submitPin(UT_PIN);
    await waitFor(() => expect(people.verifies()).toHaveLength(1));
    expect(people.verifies()[0]!.storeId).toBe('store_ut_2');
  });

  test('a PIN in any membership is required, even when the selected store has none', async () => {
    const people = await sharedPhone({
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
    // Her selected store has no PIN: choosing it must not be a way around the other one's.
    useCurrentStore.getState().selectStore('user_ut', 'store_ut');
    await openPinFor(0);
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    await submitPin(UT_PIN);
    await waitFor(() => expect(clerkMock.setActive).toHaveBeenCalledTimes(1));
    expect(people.verifies()).toHaveLength(1);
    expect(people.verifies()[0]).toMatchObject({
      token: 'token_sess_ut',
      storeId: 'store_ut_2',
    });
  });

  test('with PINs in several stores the selected store is the one verified', async () => {
    const people = await sharedPhone({
      token_sess_ut: {
        me: buildMe({
          userId: 'user_ut',
          name: 'Bé Út',
          memberships: [
            { storeId: 'store_ut', hasPin: true },
            { storeId: 'store_ut_2', hasPin: true },
          ],
        }),
        pin: UT_PIN,
      },
    });
    useCurrentStore.getState().selectStore('user_ut', 'store_ut_2');
    await openPinFor(0);
    await submitPin(UT_PIN);
    await waitFor(() => expect(people.verifies()).toHaveLength(1));
    expect(people.verifies()[0]!.storeId).toBe('store_ut_2');
  });

  test('a wrong PIN says so, stays on the sheet, clears the digits and never activates', async () => {
    const people = await sharedPhone();
    await openPinFor(0);
    await submitPin('0000');
    expect(await screen.findByText('Sai mã PIN')).toBeOnTheScreen();
    expect(screen.getByTestId('auth-switch-pin-error')).toHaveTextContent(
      'Sai mã PIN',
    );
    expect(screen.getByLabelText('0 chữ số đã nhập')).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(people.verifies()).toHaveLength(1);
    expect(getClerkState().isSignedIn).toBe(false);
    // The right PIN afterwards still works.
    await submitPin(UT_PIN);
    await waitFor(() => expect(clerkMock.setActive).toHaveBeenCalledTimes(1));
    expect(people.verifies()).toHaveLength(2);
  });

  test('a lockout shows the wait and never activates', async () => {
    await sharedPhone({
      token_sess_ut: {
        me: buildMe({
          userId: 'user_ut',
          name: 'Bé Út',
          memberships: [{ storeId: 'store_ut', hasPin: true }],
        }),
        verify: lockout,
      },
    });
    await openPinFor(0);
    await submitPin(UT_PIN);
    expect(
      await screen.findByText('Thử sai quá nhiều lần. Thử lại sau 5 phút.'),
    ).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(screen.getByTestId('auth-switch-pin')).toBeOnTheScreen();
  });

  test('closing the sheet activates nobody and keeps the list', async () => {
    const people = await sharedPhone();
    await openPinFor(0);
    await fireEvent.press(screen.getByTestId('sheet-scrim'));
    expect(screen.queryByTestId('auth-switch-pin')).toBeNull();
    expect(screen.getByTestId('auth-device-sessions')).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(people.verifies()).toHaveLength(0);
    expect(getClerkState().isSignedIn).toBe(false);
    expect(useDeviceLock.getState().locked).toBe(true);
  });

  test('a person with a PIN can only be reached through it, even with several taps', async () => {
    const people = await sharedPhone();
    await open();
    await fireEvent.press(row(0));
    await screen.findByTestId('auth-switch-pin');
    await fireEvent.press(row(0));
    await fireEvent.press(row(1));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(people.verifies()).toHaveLength(0);
  });

  test('without knowing whether a PIN exists nobody is switched, and trying again works', async () => {
    const people = await sharedPhone();
    await open();
    await within(row(1)).findByText('hai@example.com');
    people.spy.mockImplementationOnce(
      async () => new Response('x', { status: 500 }),
    );
    await fireEvent.press(row(1));
    expect(
      await screen.findByTestId('auth-device-sessions-error'),
    ).toHaveTextContent('Không chuyển được người dùng. Vui lòng thử lại.');
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    await fireEvent.press(row(1));
    await waitFor(() => expect(clerkMock.setActive).toHaveBeenCalledTimes(1));
  });
});

describe('the device lock', () => {
  const locked = () => useDeviceLock.getState().locked;

  test('lifts after setActive for a person without a PIN, not before', async () => {
    await sharedPhone();
    const lockedAtActivation: boolean[] = [];
    clerkMock.setActive.mockImplementation(async () => {
      lockedAtActivation.push(locked());
    });
    await open();
    expect(locked()).toBe(true);
    await fireEvent.press(row(1));
    await waitFor(() => expect(locked()).toBe(false));
    expect(lockedAtActivation).toEqual([true]);
  });

  test('lifts after the right PIN and setActive, not before', async () => {
    await sharedPhone();
    const lockedAtActivation: boolean[] = [];
    clerkMock.setActive.mockImplementation(async () => {
      lockedAtActivation.push(locked());
    });
    await openPinFor(0);
    expect(locked()).toBe(true);
    await submitPin(UT_PIN);
    await waitFor(() => expect(locked()).toBe(false));
    expect(lockedAtActivation).toEqual([true]);
  });

  test('stays locked after a wrong PIN, a failed activation and a lockout', async () => {
    await sharedPhone({
      token_sess_hai: {
        me: buildMe({
          userId: 'user_hai',
          name: 'Hai',
          memberships: [{ storeId: 'store_hai', hasPin: true }],
        }),
        verify: lockout,
      },
    });
    await openPinFor(0);
    await submitPin('0000');
    await screen.findByText('Sai mã PIN');
    expect(locked()).toBe(true);
    // The right PIN, but Clerk cannot activate: still locked.
    clerkMock.setActive.mockRejectedValueOnce(new Error('offline'));
    await submitPin(UT_PIN);
    await screen.findByText('Không chuyển được người dùng. Vui lòng thử lại.');
    expect(locked()).toBe(true);
    await fireEvent.press(row(1));
    await screen.findByTestId('auth-switch-pin');
    await submitPin(UT_PIN);
    await screen.findByText('Thử sai quá nhiều lần. Thử lại sau 5 phút.');
    expect(locked()).toBe(true);
    expect(getClerkState().isSignedIn).toBe(false);
  });

  test('a fresh Google sign-in lifts it', async () => {
    await sharedPhone(googlePerson);
    await open();
    await fireEvent.press(screen.getByTestId('auth-google'));
    await waitFor(() => expect(locked()).toBe(false));
    expect(clerkMock.setActive).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'sess_google' }),
    );
  });

  test.each([
    [
      'cancelled',
      () =>
        clerkMock.startSSOFlow.mockResolvedValueOnce({
          createdSessionId: null,
          authSessionResult: { type: 'cancel' },
        }),
    ],
    [
      'failing',
      () =>
        clerkMock.startSSOFlow.mockRejectedValueOnce(new TypeError('offline')),
    ],
  ])('a %s Google sign-in keeps it', async (_name, script) => {
    await sharedPhone();
    script();
    await open();
    await fireEvent.press(screen.getByTestId('auth-google'));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(locked()).toBe(true);
    expect(clerkMock.setActive).not.toHaveBeenCalled();
  });

  test('a lock with nobody signed in is lifted by a normal sign-in', async () => {
    installPeople(googlePerson);
    await clerkMock.signOut({ sessionId: 'sess_test' });
    useDeviceLock.getState().lock();
    await open();
    expect(screen.queryByTestId('auth-device-sessions')).toBeNull();
    await fireEvent.press(screen.getByTestId('auth-google'));
    await waitFor(() => expect(locked()).toBe(false));
  });
});
