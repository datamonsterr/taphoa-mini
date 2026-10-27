import { clerkMock, getClerkState, setClerkState } from '@/test/clerk';
import { getMockDb } from '@/test/mock/db';
import { fireEvent, renderApp, screen, waitFor } from '@/test/router';

import { useEmailFlow } from './emailFlow';

/** The new person becomes the active Clerk session once the code is finalized. */
function newPersonFinalizes({ withStore }: { withStore: boolean }) {
  clerkMock.signIn.finalize.mockImplementationOnce(
    async (options?: { navigate?: () => Promise<void> }) => {
      getMockDb().hasMembership = withStore;
      clerkMock.sessions.push({
        id: 'sess_new',
        status: 'active',
        user: { id: 'user_new', primaryEmailAddress: null },
        publicUserData: { identifier: 'new@example.com' },
        getToken: jest.fn(async () => 'token_sess_new'),
      });
      setClerkState({ userId: 'user_new', sessionId: 'sess_new' });
      await options?.navigate?.();
      return { error: null };
    },
  );
}

const addNewPerson = async () => {
  await fireEvent.changeText(
    await screen.findByTestId('auth-email'),
    'new@example.com',
  );
  await fireEvent.press(screen.getByTestId('auth-send-code'));
  await fireEvent.changeText(await screen.findByTestId('auth-code'), '424242');
  await fireEvent.press(screen.getByTestId('auth-verify-code'));
};

test('the add-person route opens while signed in and signs nobody out', async () => {
  await renderApp('/add-person');
  expect(await screen.findByTestId('auth-sign-in-screen')).toBeOnTheScreen();
  expect(screen).toHavePathname('/add-person');
  expect(clerkMock.signOut).not.toHaveBeenCalled();
  expect(getClerkState()).toMatchObject({
    isSignedIn: true,
    sessionId: 'sess_test',
  });
});

test('the account tab opens it and Cancel returns to the account tab', async () => {
  await renderApp('/account');
  await screen.findByRole('header', { name: 'Tạp hóa Cô Ba' });
  await fireEvent.press(screen.getByTestId('account-add-person'));
  expect(await screen.findByTestId('auth-sign-in-screen')).toBeOnTheScreen();
  expect(screen).toHavePathname('/add-person');
  await fireEvent.press(screen.getByTestId('auth-add-cancel'));
  expect(await screen.findByTestId('account-sessions')).toBeOnTheScreen();
  expect(screen).toHavePathname('/account');
  expect(clerkMock.signOut).not.toHaveBeenCalled();
  expect(getClerkState().sessionId).toBe('sess_test');
});

test('Cancel from the code step also returns to the account tab', async () => {
  await renderApp('/account');
  await screen.findByRole('header', { name: 'Tạp hóa Cô Ba' });
  await fireEvent.press(screen.getByTestId('account-add-person'));
  await fireEvent.changeText(
    await screen.findByTestId('auth-email'),
    'new@example.com',
  );
  await fireEvent.press(screen.getByTestId('auth-send-code'));
  await screen.findByTestId('auth-code-screen');
  expect(screen).toHavePathname('/add-person/verify-code');
  await fireEvent.press(screen.getByTestId('auth-add-cancel'));
  expect(await screen.findByTestId('account-sessions')).toBeOnTheScreen();
  expect(screen).toHavePathname('/account');
  expect(useEmailFlow.getState().email).toBe('');
});

test('a new person with a store lands in the shop as the active person', async () => {
  await renderApp('/add-person');
  newPersonFinalizes({ withStore: true });
  await addNewPerson();
  await waitFor(() => expect(screen).toHavePathname('/'));
  expect(getClerkState().userId).toBe('user_new');
  expect(screen.queryByTestId('auth-sign-in-screen')).toBeNull();
  expect(clerkMock.signOut).not.toHaveBeenCalled();
});

test('a new person without a store lands in onboarding', async () => {
  await renderApp('/add-person');
  newPersonFinalizes({ withStore: false });
  await addNewPerson();
  expect(
    await screen.findByTestId('onboarding-welcome-screen'),
  ).toBeOnTheScreen();
  expect(screen).toHavePathname('/welcome');
  expect(clerkMock.signOut).not.toHaveBeenCalled();
});
