import { getMockDb } from '@/test/mock/db';
import { clerkMock } from '@/test/clerk';
import { setApiTransport } from '@/lib/api/client';
import { renderApp, screen, fireEvent } from '@/test/router';

/** Nobody is signed in on this phone: Clerk has no active session and no session in its client. */
const signedOut = () => clerkMock.signOut({ sessionId: 'sess_test' });

test('signed out opens sign-in rather than the shop', async () => {
  await signedOut();
  await renderApp('/');
  expect(await screen.findByTestId('auth-email')).toBeOnTheScreen();
  expect(screen.queryByTestId('camera-screen')).toBeNull();
});

test('a Clerk session without memberships opens onboarding', async () => {
  setApiTransport(
    async () =>
      new Response(
        JSON.stringify({
          clerk_user_id: 'user_test',
          profile: { display_name: 'Mẹ', email: 'me@example.com' },
          memberships: [],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  await renderApp('/');
  expect(await screen.findByTestId('onboarding-create')).toBeOnTheScreen();
  expect(screen.queryByTestId('camera-screen')).toBeNull();
});

test('a Clerk session with membership opens the shop', async () => {
  await renderApp('/');
  expect(await screen.findByTestId('camera-screen')).toBeOnTheScreen();
});

test('email then code signs an existing user in with Core 3 finalize', async () => {
  await signedOut();
  await renderApp('/sign-in');
  await fireEvent.changeText(
    await screen.findByTestId('auth-email'),
    'me@example.com',
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Gửi mã' }));
  await fireEvent.changeText(await screen.findByTestId('auth-code'), '424242');
  await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
  expect(await screen.findByTestId('camera-screen')).toBeOnTheScreen();
  expect(clerkMock.signIn.emailCode.sendCode).toHaveBeenCalledWith({
    emailAddress: 'me@example.com',
  });
  expect(clerkMock.signIn.emailCode.verifyCode).toHaveBeenCalledWith({
    code: '424242',
  });
  expect(clerkMock.signIn.finalize).toHaveBeenCalledTimes(1);
});

test('an unknown identifier signs up with an email code and finalizes', async () => {
  await signedOut();
  clerkMock.signIn.create.mockResolvedValueOnce({
    error: { code: 'form_identifier_not_found' },
  });
  await renderApp('/sign-in');
  await fireEvent.changeText(
    await screen.findByTestId('auth-email'),
    'new@example.com',
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Gửi mã' }));
  await fireEvent.changeText(await screen.findByTestId('auth-code'), '424242');
  await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
  expect(await screen.findByTestId('camera-screen')).toBeOnTheScreen();
  expect(clerkMock.signUp.create).toHaveBeenCalledWith({
    emailAddress: 'new@example.com',
  });
  expect(clerkMock.signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(1);
  expect(clerkMock.signUp.verifications.verifyEmailCode).toHaveBeenCalledWith({
    code: '424242',
  });
  expect(clerkMock.signUp.finalize).toHaveBeenCalledTimes(1);
});

test('a wrong code is explained in Vietnamese and stays on verification', async () => {
  await signedOut();
  await renderApp('/sign-in');
  await fireEvent.changeText(
    await screen.findByTestId('auth-email'),
    'me@example.com',
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Gửi mã' }));
  await fireEvent.changeText(await screen.findByTestId('auth-code'), '123456');
  clerkMock.signIn.emailCode.verifyCode.mockResolvedValueOnce({
    error: { code: 'form_code_incorrect' },
  });
  await fireEvent.press(screen.getByRole('button', { name: 'Xác nhận' }));
  expect(
    await screen.findByText('Mã xác nhận không đúng. Vui lòng thử lại.'),
  ).toBeOnTheScreen();
  expect(clerkMock.signIn.finalize).not.toHaveBeenCalled();
});

test('verification can resend and change the email', async () => {
  await signedOut();
  await renderApp('/sign-in');
  await fireEvent.changeText(
    await screen.findByTestId('auth-email'),
    'me@example.com',
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Gửi mã' }));
  await fireEvent.press(await screen.findByTestId('auth-resend-code'));
  expect(clerkMock.signIn.emailCode.sendCode).toHaveBeenCalledTimes(2);
  await fireEvent.press(screen.getByTestId('auth-change-email'));
  expect(await screen.findByTestId('auth-email')).toBeOnTheScreen();
  expect(clerkMock.signIn.reset).toHaveBeenCalled();
});

test('Google SSO activates the created session', async () => {
  await signedOut();
  await renderApp('/sign-in');
  await fireEvent.press(await screen.findByTestId('auth-google'));
  expect(clerkMock.startSSOFlow).toHaveBeenCalledWith({
    strategy: 'oauth_google',
    redirectUrl: expect.stringContaining('sign-in'),
  });
  expect(clerkMock.setActive).toHaveBeenCalledWith(
    expect.objectContaining({ session: 'sess_google' }),
  );
});

test('a missing publishable key renders a configuration error', async () => {
  const key = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  try {
    await renderApp('/');
    expect(
      await screen.findByTestId('auth-configuration-error'),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(/Thiếu EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY/),
    ).toBeOnTheScreen();
  } finally {
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = key;
  }
});

test('create store enters the shop immediately after selecting the returned membership', async () => {
  getMockDb().hasMembership = false;
  await renderApp('/welcome');
  await fireEvent.press(await screen.findByTestId('onboarding-create'));
  await fireEvent.changeText(
    await screen.findByTestId('create-store-name'),
    'Tạp hóa Mẹ',
  );
  await fireEvent.press(screen.getByTestId('create-store-submit'));
  expect(await screen.findByTestId('camera-screen')).toBeOnTheScreen();
});

test('join accepts the taphoa deep-link path and enters the shop', async () => {
  getMockDb().hasMembership = false;
  await renderApp('/join?token=K7Q4MZ2P9HXDT3VA');
  expect(await screen.findByTestId('join-invite-token')).toHaveProp(
    'value',
    'K7Q4MZ2P9HXDT3VA',
  );
  await fireEvent.press(screen.getByTestId('join-store-submit'));
  expect(await screen.findByTestId('camera-screen')).toBeOnTheScreen();
});

test('onboarding can open join and sign out of only the current session', async () => {
  getMockDb().hasMembership = false;
  await renderApp('/welcome');
  await fireEvent.press(await screen.findByTestId('onboarding-join'));
  expect(await screen.findByTestId('join-invite-token')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Quay lại' }));
  await fireEvent.press(await screen.findByTestId('onboarding-sign-out'));
  expect(await screen.findByTestId('auth-email')).toBeOnTheScreen();
  expect(clerkMock.signOut).toHaveBeenCalledWith({ sessionId: 'sess_test' });
});

test('an invitation opened while signed out survives email sign-in', async () => {
  getMockDb().hasMembership = false;
  await signedOut();
  await renderApp('/join?token=K7Q4MZ2P9HXDT3VA');
  await fireEvent.changeText(
    await screen.findByTestId('auth-email'),
    'me@example.com',
  );
  await fireEvent.press(screen.getByTestId('auth-send-code'));
  await fireEvent.changeText(await screen.findByTestId('auth-code'), '424242');
  await fireEvent.press(screen.getByTestId('auth-verify-code'));
  await fireEvent.press(await screen.findByTestId('onboarding-join'));
  expect(await screen.findByTestId('join-invite-token')).toHaveProp(
    'value',
    'K7Q4MZ2P9HXDT3VA',
  );
});
