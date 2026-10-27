/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily */
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';

import { useCurrentStore } from '@/stores/currentStore';
import { useDeviceLock } from '@/stores/deviceLock';
import { addClerkSession, clerkMock, getClerkState } from '@/test/clerk';
import { buildMe, installPeople, type PersonScript } from '@/test/people';
import { renderWithProviders } from '@/test/render';

import { SignInScreen } from './SignInScreen';
import { VerifyCodeScreen } from './VerifyCodeScreen';
import { useEmailFlow } from './emailFlow';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
  Redirect: ({ href }: { href: string }) =>
    require('react').createElement(
      require('react-native').Text,
      { testID: 'redirect' },
      href,
    ),
}));

afterEach(() => jest.restoreAllMocks());
beforeEach(() => {
  mockPush.mockClear();
  mockReplace.mockClear();
});

const NEW_PIN = '4821';
const locked = () => useDeviceLock.getState().locked;

/**
 * Cô Ba signed out of a phone that hai (no PIN) is still signed in on: Clerk has nobody active
 * and the device is locked. `newcomers` script the people who will sign in next, by token.
 */
async function lockedPhone(newcomers: Record<string, PersonScript> = {}) {
  addClerkSession({
    id: 'sess_hai',
    userId: 'user_hai',
    email: 'hai@example.com',
  });
  const people = installPeople({
    token_sess_hai: {
      me: buildMe({
        userId: 'user_hai',
        name: 'Hai',
        memberships: [{ storeId: 'store_hai' }],
      }),
    },
    ...newcomers,
  });
  await clerkMock.signOut({ sessionId: 'sess_test' });
  useDeviceLock.getState().lock();
  return people;
}

/** The person who signs in next: Clerk adds their session when it completes the attempt. */
const newcomer = {
  id: 'sess_new',
  userId: 'user_new',
  email: 'new@example.com',
};
const arrives = () => addClerkSession(newcomer);
const withPin = (
  memberships: { storeId: string; hasPin?: boolean }[] = [
    { storeId: 'store_new', hasPin: true },
  ],
  extra: Partial<PersonScript> = {},
): Record<string, PersonScript> => ({
  token_sess_new: {
    me: buildMe({ userId: newcomer.userId, name: 'Mới', memberships }),
    pin: NEW_PIN,
    ...extra,
  },
});

async function emailCode(mode: 'signIn' | 'signUp' = 'signIn') {
  const resource = mode === 'signIn' ? clerkMock.signIn : clerkMock.signUp;
  resource.createdSessionId = newcomer.id;
  const finalize = resource.finalize.getMockImplementation()!;
  resource.finalize.mockImplementation(async (options) => {
    arrives();
    return finalize(options);
  });
  useEmailFlow.getState().begin('new@example.com', mode);
  await renderWithProviders(<VerifyCodeScreen />);
  await fireEvent.changeText(screen.getByTestId('auth-code'), '424242');
  await fireEvent.press(screen.getByTestId('auth-verify-code'));
}
function googleCompletes() {
  clerkMock.startSSOFlow.mockImplementationOnce(async () => {
    arrives();
    return { createdSessionId: newcomer.id, setActive: clerkMock.setActive };
  });
}
async function googleSignIn() {
  googleCompletes();
  await renderWithProviders(<SignInScreen />);
  await fireEvent.press(screen.getByTestId('auth-google'));
}

const type = async (digits: string) => {
  for (const digit of digits)
    await fireEvent.press(screen.getByRole('button', { name: digit }));
};
const submitPin = async (digits: string) => {
  await type(digits);
  // The email code screen has a "Xác nhận" button of its own.
  await fireEvent.press(
    within(screen.getByTestId('auth-switch-pin-submit')).getByRole('button'),
  );
};
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

describe.each([
  ['an email code (sign-in)', () => emailCode('signIn')],
  ['an email code (sign-up)', () => emailCode('signUp')],
  ['Google', googleSignIn],
] as const)('signing in with %s on a locked phone', (_name, signIn) => {
  test('a person with a PIN is asked for it, and the lock lifts only after it is accepted', async () => {
    const people = await lockedPhone(withPin());
    await signIn();
    expect(await screen.findByTestId('auth-switch-pin')).toBeOnTheScreen();
    expect(
      screen.getByRole('header', { name: 'Mã PIN của Mới' }),
    ).toBeOnTheScreen();
    expect(locked()).toBe(true);
    await submitPin('0000');
    expect(await screen.findByText('Sai mã PIN')).toBeOnTheScreen();
    expect(locked()).toBe(true);
    await submitPin(NEW_PIN);
    await waitFor(() => expect(locked()).toBe(false));
    // Their own token and store verified it; nobody was signed out afterwards.
    expect(
      people.verifies().map(({ token, storeId }) => [token, storeId]),
    ).toEqual([
      ['token_sess_new', 'store_new'],
      ['token_sess_new', 'store_new'],
    ]);
    expect(clerkMock.signOut).toHaveBeenCalledTimes(1); // Cô Ba signing out, before
    expect(getClerkState()).toMatchObject({
      isSignedIn: true,
      userId: 'user_new',
      sessionId: 'sess_new',
    });
    expect(screen.queryByTestId('auth-switch-pin')).toBeNull();
  });

  test('closing the PIN sheet signs the new session out and keeps the lock', async () => {
    await lockedPhone(withPin());
    await signIn();
    await screen.findByTestId('auth-switch-pin');
    await fireEvent.press(screen.getByTestId('sheet-scrim'));
    await waitFor(() =>
      expect(clerkMock.signOut).toHaveBeenCalledWith({ sessionId: 'sess_new' }),
    );
    expect(screen.queryByTestId('auth-switch-pin')).toBeNull();
    expect(locked()).toBe(true);
    // hai stays signed in; the new person is gone, and nobody is active.
    expect(clerkMock.sessions.map(({ id, status }) => [id, status])).toEqual(
      expect.arrayContaining([
        ['sess_hai', 'active'],
        ['sess_new', 'removed'],
      ]),
    );
    expect(getClerkState().isSignedIn).toBe(false);
  });

  test('a lockout shows the wait and neither unlocks nor signs out', async () => {
    await lockedPhone(
      withPin(undefined, {
        verify: () =>
          Response.json(
            { error: 'rate limit exceeded', code: 'too_many_requests' },
            { status: 429, headers: { 'Retry-After': '300' } },
          ),
      }),
    );
    await signIn();
    await screen.findByTestId('auth-switch-pin');
    await submitPin(NEW_PIN);
    expect(
      await screen.findByText('Thử sai quá nhiều lần. Thử lại sau 5 phút.'),
    ).toBeOnTheScreen();
    expect(locked()).toBe(true);
    expect(clerkMock.signOut).toHaveBeenCalledTimes(1);
  });

  test('a PIN in any of their stores counts, and that store is verified', async () => {
    const people = await lockedPhone(
      withPin([
        { storeId: 'store_a', hasPin: false },
        { storeId: 'store_b', hasPin: true },
      ]),
    );
    useCurrentStore.getState().selectStore('user_new', 'store_a');
    await signIn();
    await screen.findByTestId('auth-switch-pin');
    await submitPin(NEW_PIN);
    await waitFor(() => expect(locked()).toBe(false));
    expect(people.verifies()[0]!.storeId).toBe('store_b');
  });

  test.each([
    ['without a PIN', [{ storeId: 'store_new', hasPin: false }]],
    ['without any store', []],
  ])('a person %s is let in at once', async (_label, memberships) => {
    const people = await lockedPhone(withPin(memberships));
    await signIn();
    await waitFor(() => expect(locked()).toBe(false));
    expect(screen.queryByTestId('auth-switch-pin')).toBeNull();
    expect(people.verifies()).toHaveLength(0);
    expect(clerkMock.signOut).toHaveBeenCalledTimes(1);
    // The check read their own /me with their own token, never an active session.
    expect(people.mes().at(-1)).toMatchObject({ token: 'token_sess_new' });
  });

  test('without knowing whether a PIN exists the new session is signed out and the lock stays', async () => {
    const people = await lockedPhone(withPin());
    people.spy.mockImplementation(
      async () => new Response('boom', { status: 500 }),
    );
    await signIn();
    await waitFor(() =>
      expect(clerkMock.signOut).toHaveBeenCalledWith({ sessionId: 'sess_new' }),
    );
    expect(
      await screen.findByText('Không đăng nhập được. Vui lòng thử lại.'),
    ).toBeOnTheScreen();
    expect(locked()).toBe(true);
    expect(screen.queryByTestId('auth-switch-pin')).toBeNull();
  });
});

describe('when the phone is not locked', () => {
  test.each([
    ['an email code', () => emailCode('signIn')],
    ['Google', googleSignIn],
  ] as const)('signing in with %s asks for no PIN', async (_name, signIn) => {
    const people = await lockedPhone(withPin());
    useDeviceLock.getState().unlock();
    await signIn();
    await settle();
    expect(screen.queryByTestId('auth-switch-pin')).toBeNull();
    expect(people.verifies()).toHaveLength(0);
    expect(clerkMock.signOut).toHaveBeenCalledTimes(1);
    expect(locked()).toBe(false);
    expect(getClerkState().userId).toBe('user_new');
  });
});

describe('the email code screen after a rejected sign-in', () => {
  test('cancelling leaves the code screen for the form, with no email left', async () => {
    await lockedPhone(withPin());
    await emailCode();
    await screen.findByTestId('auth-switch-pin');
    expect(useEmailFlow.getState().email).toBe('new@example.com');
    await fireEvent.press(screen.getByTestId('sheet-scrim'));
    await waitFor(() => expect(useEmailFlow.getState().email).toBe(''));
    expect(clerkMock.signIn.reset).toHaveBeenCalled();
    expect(clerkMock.signUp.reset).toHaveBeenCalled();
    expect(screen.queryByTestId('auth-switch-pin')).toBeNull();
  });

  test('a successful PIN clears the email too', async () => {
    await lockedPhone(withPin());
    await emailCode();
    await screen.findByTestId('auth-switch-pin');
    await submitPin(NEW_PIN);
    await waitFor(() => expect(locked()).toBe(false));
    expect(useEmailFlow.getState().email).toBe('');
  });

  test('a failed read keeps the code screen with the error, so the person can change the email', async () => {
    const people = await lockedPhone(withPin());
    people.spy.mockImplementation(
      async () => new Response('boom', { status: 500 }),
    );
    await emailCode();
    expect(
      await screen.findByText('Không đăng nhập được. Vui lòng thử lại.'),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('auth-change-email')).toBeEnabled();
    expect(locked()).toBe(true);
  });
});

describe('edge cases', () => {
  test('a session Clerk does not list is never trusted: the lock stays', async () => {
    const people = await lockedPhone(withPin());
    clerkMock.signIn.createdSessionId = 'sess_ghost';
    useEmailFlow.getState().begin('new@example.com', 'signIn');
    await renderWithProviders(<VerifyCodeScreen />);
    await fireEvent.changeText(screen.getByTestId('auth-code'), '424242');
    await fireEvent.press(screen.getByTestId('auth-verify-code'));
    await settle();
    expect(locked()).toBe(true);
    expect(clerkMock.signOut).toHaveBeenCalledWith({ sessionId: 'sess_ghost' });
    expect(people.requests).toHaveLength(0);
  });

  test('without a created session id nobody is signed out, and the lock stays', async () => {
    await lockedPhone(withPin());
    clerkMock.signIn.createdSessionId = null;
    useEmailFlow.getState().begin('new@example.com', 'signIn');
    await renderWithProviders(<VerifyCodeScreen />);
    await fireEvent.changeText(screen.getByTestId('auth-code'), '424242');
    await fireEvent.press(screen.getByTestId('auth-verify-code'));
    await settle();
    expect(locked()).toBe(true);
    expect(clerkMock.signOut).toHaveBeenCalledTimes(1);
  });

  test('a failed sign-out of the rejected session still keeps the lock and says so', async () => {
    await lockedPhone(withPin());
    await googleSignIn();
    await screen.findByTestId('auth-switch-pin');
    clerkMock.signOut.mockRejectedValueOnce(new Error('offline'));
    await fireEvent.press(screen.getByTestId('sheet-scrim'));
    expect(
      await screen.findByText('Không đăng nhập được. Vui lòng thử lại.'),
    ).toBeOnTheScreen();
    expect(locked()).toBe(true);
  });
});
