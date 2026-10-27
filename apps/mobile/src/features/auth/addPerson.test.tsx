/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { clerkMock, getClerkState, setClerkState } from '@/test/clerk';
import { renderWithProviders } from '@/test/render';

import { AddPersonLayout } from './AddPersonLayout';
import { SignInScreen } from './SignInScreen';
import { VerifyCodeScreen } from './VerifyCodeScreen';
import { useAddPerson } from './addPerson';
import { useEmailFlow } from './emailFlow';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: mockBack,
    dismissTo: mockDismissTo,
  }),
  Redirect: ({ href }: { href: string }) =>
    require('react').createElement(
      require('react-native').Text,
      { testID: 'redirect' },
      href,
    ),
  Stack: () =>
    require('react').createElement(require('react-native').View, {
      testID: 'add-person-stack',
    }),
}));
beforeEach(() => {
  for (const spy of [mockPush, mockReplace, mockBack, mockDismissTo])
    spy.mockClear();
});

const addForm = async () => renderWithProviders(<SignInScreen flow="add" />);
const addCode = async (mode: 'signIn' | 'signUp' = 'signIn') => {
  useEmailFlow.getState().begin('new@example.com', mode);
  await renderWithProviders(<VerifyCodeScreen flow="add" />);
};
const enterCode = async () => {
  await fireEvent.changeText(screen.getByTestId('auth-code'), '424242');
  await fireEvent.press(screen.getByTestId('auth-verify-code'));
};

describe('sign-in form in add mode', () => {
  test('is titled for adding a person and keeps the usual fields', async () => {
    await addForm();
    expect(
      screen.getByRole('header', { name: 'Thêm người trên máy này' }),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('auth-sign-in-screen')).toBeOnTheScreen();
    expect(screen.getByTestId('auth-email')).toBeOnTheScreen();
    expect(screen.getByTestId('auth-send-code')).toBeOnTheScreen();
    expect(screen.getByTestId('auth-google')).toBeOnTheScreen();
    expect(screen.getByTestId('auth-add-cancel')).toBeOnTheScreen();
  });

  test('the normal sign-in has no cancel and keeps its title', async () => {
    await renderWithProviders(<SignInScreen />);
    expect(screen.getByRole('header', { name: 'Đăng nhập' })).toBeOnTheScreen();
    expect(screen.queryByTestId('auth-add-cancel')).toBeNull();
  });

  test('sending a code continues on the add-person verification route', async () => {
    await addForm();
    await fireEvent.changeText(
      screen.getByTestId('auth-email'),
      'new@example.com',
    );
    await fireEvent.press(screen.getByTestId('auth-send-code'));
    expect(clerkMock.signIn.emailCode.sendCode).toHaveBeenCalledWith({
      emailAddress: 'new@example.com',
    });
    expect(mockPush).toHaveBeenCalledWith('/add-person/verify-code');
    expect(clerkMock.signOut).not.toHaveBeenCalled();
  });

  test('cancel drops the attempt and returns to the account tab, signing nobody out', async () => {
    useEmailFlow.getState().begin('new@example.com', 'signIn');
    await addForm();
    await fireEvent.press(screen.getByTestId('auth-add-cancel'));
    await screen.findByTestId('auth-add-cancel');
    expect(mockDismissTo).toHaveBeenCalledWith('/account');
    expect(clerkMock.signIn.reset).toHaveBeenCalled();
    expect(clerkMock.signUp.reset).toHaveBeenCalled();
    expect(useEmailFlow.getState().email).toBe('');
    expect(clerkMock.signOut).not.toHaveBeenCalled();
    expect(getClerkState().sessionId).toBe('sess_test');
  });

  test('Google comes back to the add-person route, which still renders while signed in', async () => {
    await addForm();
    await fireEvent.press(screen.getByTestId('auth-google'));
    expect(clerkMock.startSSOFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        strategy: 'oauth_google',
        redirectUrl: 'taphoa://add-person',
      }),
    );
    expect(clerkMock.setActive).toHaveBeenCalledWith({
      session: 'sess_google',
      navigate: expect.any(Function),
    });
    expect(clerkMock.signOut).not.toHaveBeenCalled();
  });

  test('the normal Google sign-in keeps the sign-in callback', async () => {
    await renderWithProviders(<SignInScreen />);
    await fireEvent.press(screen.getByTestId('auth-google'));
    expect(clerkMock.startSSOFlow).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: 'taphoa://sign-in' }),
    );
  });
});

describe('verification in add mode', () => {
  test('a finished code activates the new session, resets the form and signs nobody out', async () => {
    await addCode();
    await enterCode();
    expect(clerkMock.signIn.finalize).toHaveBeenCalledWith({
      navigate: expect.any(Function),
    });
    expect(useEmailFlow.getState().email).toBe('');
    expect(clerkMock.signOut).not.toHaveBeenCalled();
  });

  test('a new email finishes sign-up the same way', async () => {
    await addCode('signUp');
    await enterCode();
    expect(clerkMock.signUp.finalize).toHaveBeenCalledWith({
      navigate: expect.any(Function),
    });
    expect(clerkMock.signOut).not.toHaveBeenCalled();
  });

  test('changing the email returns to the add-person form', async () => {
    await addCode();
    await fireEvent.press(screen.getByTestId('auth-change-email'));
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/add-person'),
    );
  });

  test('without an email it sends the visitor back to the add-person form', async () => {
    await renderWithProviders(<VerifyCodeScreen flow="add" />);
    expect(screen.getByTestId('redirect')).toHaveTextContent('/add-person');
  });

  test('cancel returns to the account tab and keeps every session', async () => {
    await addCode();
    await fireEvent.press(screen.getByTestId('auth-add-cancel'));
    await waitFor(() => expect(mockDismissTo).toHaveBeenCalledWith('/account'));
    expect(useEmailFlow.getState().email).toBe('');
    // The cleared email must not redirect back to the form while the screen leaves.
    expect(screen.queryByTestId('redirect')).toBeNull();
    expect(clerkMock.signOut).not.toHaveBeenCalled();
  });

  test('the normal verification has no cancel', async () => {
    useEmailFlow.getState().begin('me@example.com', 'signIn');
    await renderWithProviders(<VerifyCodeScreen />);
    expect(screen.queryByTestId('auth-add-cancel')).toBeNull();
  });
});

describe('add-person layout', () => {
  test('keeps the add routes while the person who started it is still active', async () => {
    useAddPerson.getState().begin('sess_test');
    await renderWithProviders(<AddPersonLayout />);
    expect(screen.getByTestId('add-person-stack')).toBeOnTheScreen();
    expect(screen.queryByTestId('redirect')).toBeNull();
  });

  test('a direct visit starts from the active session', async () => {
    await renderWithProviders(<AddPersonLayout />);
    expect(screen.getByTestId('add-person-stack')).toBeOnTheScreen();
    expect(useAddPerson.getState().from).toBe('sess_test');
  });

  test('hands over to the gate once the new session is active and restarts from them', async () => {
    useAddPerson.getState().begin('sess_test');
    await renderWithProviders(<AddPersonLayout />);
    await act(async () =>
      setClerkState({ userId: 'user_new', sessionId: 'sess_new' }),
    );
    expect(screen.getByTestId('redirect')).toHaveTextContent('/');
    expect(screen.queryByTestId('add-person-stack')).toBeNull();
    expect(useAddPerson.getState().from).toBe('sess_new');
  });

  test('a visit while nobody is signed in starts from nobody', async () => {
    setClerkState({ isSignedIn: false, userId: null, sessionId: null });
    await renderWithProviders(<AddPersonLayout />);
    expect(useAddPerson.getState().from).toBeNull();
    expect(screen.getByTestId('add-person-stack')).toBeOnTheScreen();
  });
});
