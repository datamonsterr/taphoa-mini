import AsyncStorage from '@react-native-async-storage/async-storage';

import { setApiTransport } from '@/lib/api/client';
import { useDeviceLock } from '@/stores/deviceLock';
import { addClerkSession, clerkMock, getClerkState } from '@/test/clerk';
import { getMockDb } from '@/test/mock/db';
import { createMockFetch } from '@/test/mock/fetch';
import { buildMe, installPeople, type PersonScript } from '@/test/people';
import { fireEvent, renderApp, screen, waitFor, within } from '@/test/router';
import { testSession } from '@/test/session';

afterEach(() => jest.restoreAllMocks());

const UT_PIN = '4821';

/** Whoever becomes active is a member of the seed store. Returns the paths the app asked for. */
function everyoneIsMember() {
  const mock = createMockFetch();
  const paths: string[] = [];
  setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    paths.push(new URL(request.url).pathname);
    return new URL(request.url).pathname === '/v1/me'
      ? Response.json({
          clerk_user_id: getClerkState().userId ?? 'user_test',
          profile: null,
          memberships: [testSession()],
        })
      : mock(request);
  }) as typeof fetch);
  return paths;
}

/** Cô Ba is signed in on a phone that Bé Út (with a PIN) and hai (none) also have a session on. */
function sharedPhone(overrides: Record<string, PersonScript> = {}) {
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
    // Cô Ba, active on her own token.
    'test-clerk-token': {
      me: buildMe({
        userId: 'user_test',
        name: 'Cô Ba',
        memberships: [{ storeId: testSession().store.id }],
      }),
    },
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
        name: 'Hai',
        memberships: [{ storeId: 'store_hai', memberName: 'Anh Hai' }],
      }),
    },
    ...overrides,
  });
}

const signOutFromAccount = async () => {
  await renderApp('/account');
  await screen.findByRole('header', { name: 'Tạp hóa Cô Ba' });
  await fireEvent.press(screen.getByTestId('account-sign-out'));
};

describe('after "Đăng xuất" with other people on the phone', () => {
  test('the root gate shows the sign-in screen with the list and activates nobody', async () => {
    sharedPhone();
    await signOutFromAccount();
    expect(await screen.findByTestId('auth-sign-in-screen')).toBeOnTheScreen();
    expect(screen).toHavePathname('/sign-in');
    expect(screen.getByTestId('auth-device-sessions')).toBeOnTheScreen();
    expect(await screen.findByText('Bé Út')).toBeOnTheScreen();
    expect(await screen.findByText('Hai')).toBeOnTheScreen();
    expect(screen.getByTestId('auth-email')).toBeOnTheScreen();
    expect(clerkMock.signOut).toHaveBeenCalledWith({ sessionId: 'sess_test' });
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(getClerkState()).toMatchObject({
      isSignedIn: false,
      userId: null,
      sessionId: null,
    });
    expect(useDeviceLock.getState().locked).toBe(true);
    // The shop is out of reach until somebody is picked.
    expect(screen.queryByTestId('account-sessions')).toBeNull();
  });

  test('picking a person without a PIN opens the shop as that person', async () => {
    sharedPhone();
    everyoneIsMember();
    await signOutFromAccount();
    await fireEvent.press(await screen.findByTestId('auth-device-session-1'));
    await waitFor(() => expect(screen).toHavePathname('/'));
    expect(getClerkState().userId).toBe('user_hai');
    expect(screen.queryByTestId('auth-sign-in-screen')).toBeNull();
  });

  test('picking a person with a PIN opens the shop only after the PIN is accepted', async () => {
    const people = sharedPhone();
    everyoneIsMember();
    await signOutFromAccount();
    await fireEvent.press(await screen.findByTestId('auth-device-session-0'));
    await screen.findByTestId('auth-switch-pin');
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    for (const digit of '0000')
      await fireEvent.press(screen.getByRole('button', { name: digit }));
    await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
    expect(await screen.findByText('Sai mã PIN')).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(screen).toHavePathname('/sign-in');
    for (const digit of UT_PIN)
      await fireEvent.press(screen.getByRole('button', { name: digit }));
    await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
    await waitFor(() => expect(screen).toHavePathname('/'));
    expect(getClerkState().userId).toBe('user_ut');
    expect(people.verifies().map(({ token }) => token)).toEqual([
      'token_sess_ut',
      'token_sess_ut',
    ]);
  });

  test('the last person to sign out gets the plain sign-in screen', async () => {
    installPeople({});
    await signOutFromAccount();
    expect(await screen.findByTestId('auth-sign-in-screen')).toBeOnTheScreen();
    expect(screen).toHavePathname('/sign-in');
    expect(screen.queryByTestId('auth-device-sessions')).toBeNull();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(useDeviceLock.getState().locked).toBe(false);
  });

  test('signing out from onboarding does the same', async () => {
    sharedPhone();
    getMockDb().hasMembership = false;
    await renderApp('/welcome');
    await fireEvent.press(await screen.findByTestId('onboarding-sign-out'));
    expect(await screen.findByTestId('auth-sign-in-screen')).toBeOnTheScreen();
    expect(await screen.findByTestId('auth-device-sessions')).toBeOnTheScreen();
    expect(clerkMock.setActive).not.toHaveBeenCalled();
  });
});

describe('cold start while the device is locked', () => {
  /** The lock was stored by the previous run; clerk-js has activated Cô Ba on its own. */
  const coldStart = async (url = '/') => {
    useDeviceLock.setState({ locked: false, hydrated: false });
    await AsyncStorage.setItem(
      'taphoa-device-lock',
      JSON.stringify({ state: { locked: true }, version: 0 }),
    );
    await useDeviceLock.persist.rehydrate();
    jest.mocked(AsyncStorage.setItem).mockClear();
    await renderApp(url);
  };
  const enterPin = async (digits: string) => {
    for (const digit of digits)
      await fireEvent.press(screen.getByRole('button', { name: digit }));
    await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
  };

  test('shows the sign-in screen with the picker and renders no shop route', async () => {
    sharedPhone();
    const requests = everyoneIsMember();
    await coldStart();
    expect(await screen.findByTestId('auth-sign-in-screen')).toBeOnTheScreen();
    expect(screen).toHavePathname('/sign-in');
    expect(screen.getByTestId('auth-device-session-2')).toBeOnTheScreen();
    expect(screen.queryByTestId('auth-device-session-3')).toBeNull();
    expect(await screen.findByText('Cô Ba')).toBeOnTheScreen();
    // The auto-activated session is Cô Ba, yet her data was never requested.
    expect(getClerkState()).toMatchObject({ sessionId: 'sess_test' });
    expect(requests).toEqual([]);
    expect(clerkMock.setActive).not.toHaveBeenCalled();
    expect(useDeviceLock.getState().locked).toBe(true);
  });

  test('deep links into the shop land on the sign-in screen too', async () => {
    sharedPhone();
    everyoneIsMember();
    await coldStart('/account');
    expect(await screen.findByTestId('auth-sign-in-screen')).toBeOnTheScreen();
    expect(screen).toHavePathname('/sign-in');
    expect(screen.queryByTestId('account-sessions')).toBeNull();
  });

  test('the right PIN lifts the lock and opens the shop as that person', async () => {
    const people = sharedPhone();
    everyoneIsMember();
    await coldStart();
    await fireEvent.press(await screen.findByTestId('auth-device-session-1'));
    await screen.findByTestId('auth-switch-pin');
    await enterPin(UT_PIN);
    await waitFor(() => expect(screen).toHavePathname('/'));
    expect(getClerkState().userId).toBe('user_ut');
    expect(useDeviceLock.getState().locked).toBe(false);
    expect(people.verifies()).toHaveLength(1);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'taphoa-device-lock',
      JSON.stringify({ state: { locked: false }, version: 0 }),
    );
  });

  test('a wrong PIN keeps the phone locked on the sign-in screen', async () => {
    sharedPhone();
    everyoneIsMember();
    await coldStart();
    await fireEvent.press(await screen.findByTestId('auth-device-session-1'));
    await screen.findByTestId('auth-switch-pin');
    await enterPin('0000');
    expect(await screen.findByText('Sai mã PIN')).toBeOnTheScreen();
    expect(screen).toHavePathname('/sign-in');
    expect(useDeviceLock.getState().locked).toBe(true);
    expect(clerkMock.setActive).not.toHaveBeenCalled();
  });

  test('a person without a PIN lifts the lock at once', async () => {
    sharedPhone();
    everyoneIsMember();
    await coldStart();
    await fireEvent.press(await screen.findByTestId('auth-device-session-2'));
    await waitFor(() => expect(screen).toHavePathname('/'));
    expect(getClerkState().userId).toBe('user_hai');
    expect(useDeviceLock.getState().locked).toBe(false);
  });

  test('the auto-activated person has to be picked like anyone else', async () => {
    sharedPhone();
    everyoneIsMember();
    await coldStart();
    await fireEvent.press(await screen.findByTestId('auth-device-session-0'));
    await waitFor(() => expect(screen).toHavePathname('/'));
    expect(getClerkState().userId).toBe('user_test');
    expect(useDeviceLock.getState().locked).toBe(false);
  });

  test('a fresh email sign-in lifts the lock', async () => {
    sharedPhone();
    everyoneIsMember();
    await coldStart();
    await fireEvent.changeText(
      await screen.findByTestId('auth-email'),
      'new@example.com',
    );
    await fireEvent.press(screen.getByTestId('auth-send-code'));
    await fireEvent.changeText(
      await screen.findByTestId('auth-code'),
      '424242',
    );
    await fireEvent.press(screen.getByTestId('auth-verify-code'));
    await waitFor(() => expect(screen).toHavePathname('/'));
    expect(useDeviceLock.getState().locked).toBe(false);
    expect(clerkMock.signIn.finalize).toHaveBeenCalledTimes(1);
  });

  describe('a fresh email sign-in by a person who has a PIN', () => {
    /** Cô Ba comes back by email on the locked phone, and she has a PIN in her store. */
    const signInByEmail = async () => {
      const people = sharedPhone({
        'test-clerk-token': {
          me: buildMe({
            userId: 'user_test',
            name: 'Cô Ba',
            memberships: [{ storeId: testSession().store.id, hasPin: true }],
          }),
          pin: UT_PIN,
        },
      });
      everyoneIsMember();
      await coldStart();
      await fireEvent.changeText(
        await screen.findByTestId('auth-email'),
        'coba@example.com',
      );
      await fireEvent.press(screen.getByTestId('auth-send-code'));
      await fireEvent.changeText(
        await screen.findByTestId('auth-code'),
        '424242',
      );
      await fireEvent.press(screen.getByTestId('auth-verify-code'));
      await screen.findByTestId('auth-switch-pin');
      return people;
    };

    test('stays on the code screen behind the PIN sheet and opens the shop only after it', async () => {
      const people = await signInByEmail();
      expect(screen).toHavePathname('/verify-code');
      expect(useDeviceLock.getState().locked).toBe(true);
      expect(screen.queryByTestId('account-sessions')).toBeNull();
      for (const digit of UT_PIN)
        await fireEvent.press(screen.getByRole('button', { name: digit }));
      await fireEvent.press(
        within(screen.getByTestId('auth-switch-pin-submit')).getByRole(
          'button',
        ),
      );
      await waitFor(() => expect(screen).toHavePathname('/'));
      expect(useDeviceLock.getState().locked).toBe(false);
      expect(people.verifies()).toHaveLength(1);
      expect(people.verifies()[0]).toMatchObject({ token: 'test-clerk-token' });
    });

    test('closing the sheet signs her out again and returns to the picker, still locked', async () => {
      await signInByEmail();
      await fireEvent.press(screen.getByTestId('sheet-scrim'));
      await waitFor(() =>
        expect(clerkMock.signOut).toHaveBeenCalledWith({
          sessionId: 'sess_test',
        }),
      );
      await waitFor(() => expect(screen).toHavePathname('/sign-in'));
      expect(
        await screen.findByTestId('auth-device-sessions'),
      ).toBeOnTheScreen();
      expect(useDeviceLock.getState().locked).toBe(true);
      expect(getClerkState().isSignedIn).toBe(false);
    });
  });

  test('a stored lock with nobody signed in does not trap anyone', async () => {
    installPeople({});
    everyoneIsMember();
    await clerkMock.signOut({ sessionId: 'sess_test' });
    await coldStart();
    expect(await screen.findByTestId('auth-sign-in-screen')).toBeOnTheScreen();
    expect(screen.queryByTestId('auth-device-sessions')).toBeNull();
    await fireEvent.changeText(
      screen.getByTestId('auth-email'),
      'new@example.com',
    );
    await fireEvent.press(screen.getByTestId('auth-send-code'));
    await fireEvent.changeText(
      await screen.findByTestId('auth-code'),
      '424242',
    );
    await fireEvent.press(screen.getByTestId('auth-verify-code'));
    await waitFor(() => expect(screen).toHavePathname('/'));
    expect(useDeviceLock.getState().locked).toBe(false);
  });
});
