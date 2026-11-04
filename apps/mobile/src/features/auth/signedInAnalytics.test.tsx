import { act, fireEvent, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { setAnalyticsSink } from '@/lib/analytics';
import { clerkMock, getClerkState, setClerkState } from '@/test/clerk';
import { renderWithProviders } from '@/test/render';

import { AuthGate } from './AuthGate';
import { SignInScreen } from './SignInScreen';
import { VerifyCodeScreen } from './VerifyCodeScreen';
import { useEmailFlow } from './emailFlow';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useGlobalSearchParams: () => ({}),
  usePathname: () => '/',
  Redirect: () => null,
}));

const captured = jest.fn();
beforeEach(() => {
  captured.mockReset().mockImplementation(getClerkState);
  setAnalyticsSink({ capture: captured });
});
afterEach(() => setAnalyticsSink(null));

test.each(['signIn', 'signUp'] as const)(
  'email %s emits once, only after the session is activated',
  async (mode) => {
    setClerkState({ isSignedIn: false, userId: null, sessionId: null });
    const resource = clerkMock[mode];
    const finalize = resource.finalize.getMockImplementation()!;
    let complete!: () => void;
    const activation = new Promise<void>((resolve) => {
      complete = resolve;
    });
    resource.finalize.mockImplementationOnce(async (options) => {
      await activation;
      return finalize(options);
    });
    useEmailFlow.getState().begin('me@example.com', mode);
    await renderWithProviders(<VerifyCodeScreen />);
    await fireEvent.changeText(screen.getByTestId('auth-code'), '424242');
    await fireEvent.press(screen.getByTestId('auth-verify-code'));
    expect(resource.finalize).toHaveBeenCalledTimes(1);
    expect(captured).not.toHaveBeenCalled();
    await act(async () => complete());
    expect(captured.mock.calls).toEqual([
      ['signed_in', { method: 'email_code' }],
    ]);

    expect(captured.mock.results[0]!.value).toMatchObject({
      isSignedIn: true,
      sessionId: 'sess_test',
    });

    // A repeated keyboard submission and rerender of the same session do not double count.
    await act(async () =>
      useEmailFlow.getState().begin('me@example.com', mode),
    );
    await fireEvent(screen.getByTestId('auth-code'), 'submitEditing');
    expect(captured).toHaveBeenCalledTimes(1);
  },
);

test('Google emits once, only after setActive succeeds', async () => {
  setClerkState({ isSignedIn: false, userId: null, sessionId: null });
  const setActive = clerkMock.setActive.getMockImplementation()!;
  let complete!: () => void;
  const activation = new Promise<void>((resolve) => {
    complete = resolve;
  });
  clerkMock.setActive.mockImplementationOnce(async (options) => {
    await activation;
    return setActive(options);
  });
  await renderWithProviders(<SignInScreen />);
  await fireEvent.press(screen.getByTestId('auth-google'));
  expect(clerkMock.setActive).toHaveBeenCalledTimes(1);
  expect(captured).not.toHaveBeenCalled();
  await act(async () => complete());
  expect(captured.mock.calls).toEqual([['signed_in', { method: 'google' }]]);
  expect(captured.mock.results[0]!.value).toMatchObject({
    isSignedIn: true,
    sessionId: 'sess_google',
  });
  // Clerk returning the same completed session must not count another sign-in.
  await fireEvent.press(screen.getByTestId('auth-google'));
  expect(captured).toHaveBeenCalledTimes(1);
});

test('failed email finalization does not emit', async () => {
  clerkMock.signIn.finalize.mockResolvedValueOnce({
    error: { code: 'network_error' },
  });
  useEmailFlow.getState().begin('me@example.com', 'signIn');
  await renderWithProviders(<VerifyCodeScreen />);
  await fireEvent.changeText(screen.getByTestId('auth-code'), '424242');
  await fireEvent.press(screen.getByTestId('auth-verify-code'));
  expect(clerkMock.signIn.finalize).toHaveBeenCalledTimes(1);
  expect(captured).not.toHaveBeenCalled();
});

test('failed Google activation does not emit', async () => {
  clerkMock.setActive.mockRejectedValueOnce(new Error('offline'));
  await renderWithProviders(<SignInScreen />);
  await fireEvent.press(screen.getByTestId('auth-google'));
  expect(clerkMock.setActive).toHaveBeenCalledTimes(1);
  expect(captured).not.toHaveBeenCalled();
});

test('restoring an existing session and refreshing its token do not emit', async () => {
  const gate = (
    <AuthGate>
      {({ signedIn }) => <Text>{signedIn ? 'restored' : 'signed-out'}</Text>}
    </AuthGate>
  );
  const view = await renderWithProviders(gate);
  await screen.findByText('restored');
  await act(async () => {
    clerkMock.getToken.mockResolvedValue('refreshed-token');
    await clerkMock.getToken({ skipCache: true });
    setClerkState({});
  });
  await view.unmount();
  await renderWithProviders(gate);
  await screen.findByText('restored');
  expect(captured).not.toHaveBeenCalled();
  expect(clerkMock.signIn.finalize).not.toHaveBeenCalled();
  expect(clerkMock.setActive).not.toHaveBeenCalled();
});
