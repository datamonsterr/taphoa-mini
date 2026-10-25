import { setApiTransport } from '@/lib/api/client';
import { addClerkSession, clerkMock, getClerkState } from '@/test/clerk';
import { getMockDb } from '@/test/mock/db';
import { createMockFetch } from '@/test/mock/fetch';
import { buildMe, installPeople } from '@/test/people';
import { fireEvent, renderApp, screen, waitFor } from '@/test/router';
import { testSession } from '@/test/session';

afterEach(() => jest.restoreAllMocks());

const UT_PIN = '4821';

/** Whoever becomes active is a member of the seed store. */
function everyoneIsMember() {
  const mock = createMockFetch();
  setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return new URL(request.url).pathname === '/v1/me'
      ? Response.json({
          clerk_user_id: getClerkState().userId ?? 'user_test',
          profile: null,
          memberships: [testSession()],
        })
      : mock(request);
  }) as typeof fetch);
}

/** Cô Ba is signed in on a phone that Bé Út (with a PIN) and hai (none) also have a session on. */
function sharedPhone() {
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
        name: 'Hai',
        memberships: [{ storeId: 'store_hai' }],
      }),
    },
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
