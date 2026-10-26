import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { SignInScreen } from './SignInScreen';
import { VerifyCodeScreen } from './VerifyCodeScreen';
import { useEmailFlow } from './emailFlow';
import { useDeviceLock } from '@/stores/deviceLock';
import { clerkMock, setClerkState } from '@/test/clerk';
import { buildMe, installPeople } from '@/test/people';
import { renderWithProviders } from '@/test/render';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
  Redirect: () => null,
}));
beforeEach(() => {
  setClerkState({ isSignedIn: false, userId: null, sessionId: null });
  mockPush.mockClear();
  mockReplace.mockClear();
});

async function sendEmail() {
  await renderWithProviders(<SignInScreen />);
  await fireEvent.changeText(
    screen.getByTestId('auth-email'),
    'me@example.com',
  );
  await fireEvent.press(screen.getByTestId('auth-send-code'));
}
async function codeScreen(mode: 'signIn' | 'signUp' = 'signIn') {
  useEmailFlow.getState().begin('me@example.com', mode);
  await renderWithProviders(<VerifyCodeScreen />);
}

test('validates the email before requesting a code', async () => {
  await renderWithProviders(<SignInScreen />);
  await fireEvent.press(screen.getByTestId('auth-send-code'));
  expect(screen.getByText('Nhập địa chỉ email hợp lệ.')).toBeOnTheScreen();
  expect(clerkMock.signIn.create).not.toHaveBeenCalled();
});
test.each(['create', 'send'] as const)(
  'an existing user sees a friendly rate limit when %s fails',
  async (stage) => {
    (stage === 'create'
      ? clerkMock.signIn.create
      : clerkMock.signIn.emailCode.sendCode
    ).mockResolvedValueOnce({ error: { code: 'too_many_requests' } });
    await sendEmail();
    expect(
      screen.getByText('Thử quá nhiều lần. Đợi một lúc rồi thử lại.'),
    ).toBeOnTheScreen();
    expect(mockPush).not.toHaveBeenCalled();
  },
);
test.each(['create', 'send'] as const)(
  'a new email stays on the form when sign-up %s fails',
  async (stage) => {
    clerkMock.signIn.create.mockResolvedValueOnce({
      error: { cause: { errors: [{ code: 'form_identifier_not_found' }] } },
    });
    (stage === 'create'
      ? clerkMock.signUp.create
      : clerkMock.signUp.verifications.sendEmailCode
    ).mockResolvedValueOnce({ error: { code: 'network_error' } });
    await sendEmail();
    expect(
      screen.getByText('Không kết nối được. Kiểm tra mạng rồi thử lại.'),
    ).toBeOnTheScreen();
    expect(mockPush).not.toHaveBeenCalled();
  },
);
test('keyboard submission sends the email', async () => {
  await renderWithProviders(<SignInScreen />);
  await fireEvent.changeText(
    screen.getByTestId('auth-email'),
    'me@example.com',
  );
  await fireEvent(screen.getByTestId('auth-email'), 'submitEditing');
  expect(mockPush).toHaveBeenCalledWith('/verify-code');
});
test('a verification route without an email has no code form', async () => {
  await renderWithProviders(<VerifyCodeScreen />);
  expect(screen.queryByTestId('auth-code')).toBeNull();
});
test('requires six digits before contacting Clerk', async () => {
  await codeScreen();
  await fireEvent.changeText(screen.getByTestId('auth-code'), '123');
  await fireEvent.press(screen.getByTestId('auth-verify-code'));
  expect(screen.getByText('Nhập mã gồm 6 chữ số.')).toBeOnTheScreen();
  expect(clerkMock.signIn.emailCode.verifyCode).not.toHaveBeenCalled();
});
test('expired sign-up code stays on verification and can be resent', async () => {
  clerkMock.signUp.verifications.verifyEmailCode.mockResolvedValueOnce({
    error: { code: 'verification_expired' },
  });
  await codeScreen('signUp');
  await fireEvent.changeText(screen.getByTestId('auth-code'), '123456');
  await fireEvent.press(screen.getByTestId('auth-verify-code'));
  expect(
    screen.getByText('Mã đã hết hạn. Vui lòng gửi lại mã.'),
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('auth-resend-code'));
  expect(clerkMock.signUp.verifications.sendEmailCode).toHaveBeenCalledTimes(1);
});
test('an incomplete verification explains the extra requirement without activating it', async () => {
  clerkMock.signIn.emailCode.verifyCode.mockResolvedValueOnce({ error: null });
  await codeScreen();
  await fireEvent.changeText(screen.getByTestId('auth-code'), '424242');
  await fireEvent.press(screen.getByTestId('auth-verify-code'));
  expect(
    screen.getByText(
      'Tài khoản cần thêm bước xác minh. Vui lòng liên hệ hỗ trợ.',
    ),
  ).toBeOnTheScreen();
  expect(clerkMock.signIn.finalize).not.toHaveBeenCalled();
});
test('finalization errors are shown and keep the code', async () => {
  clerkMock.signIn.finalize.mockResolvedValueOnce({
    error: { code: 'network_error' },
  });
  await codeScreen();
  await fireEvent.changeText(screen.getByTestId('auth-code'), '424242');
  await fireEvent(screen.getByTestId('auth-code'), 'submitEditing');
  expect(
    screen.getByText('Không kết nối được. Kiểm tra mạng rồi thử lại.'),
  ).toBeOnTheScreen();
  expect(screen.getByTestId('auth-code')).toHaveProp('value', '424242');
});
test('resend failures leave verification usable', async () => {
  clerkMock.signIn.emailCode.sendCode.mockRejectedValueOnce(
    new TypeError('offline'),
  );
  await codeScreen();
  await fireEvent.press(screen.getByTestId('auth-resend-code'));
  expect(
    screen.getByText('Không kết nối được. Kiểm tra mạng rồi thử lại.'),
  ).toBeOnTheScreen();
  expect(screen.getByTestId('auth-verify-code')).toBeEnabled();
});
test.each(['cancel', 'dismiss'])(
  'Google %s returns to sign-in quietly',
  async (type) => {
    clerkMock.startSSOFlow.mockResolvedValueOnce({
      createdSessionId: null,
      authSessionResult: { type },
    });
    await renderWithProviders(<SignInScreen />);
    await fireEvent.press(screen.getByTestId('auth-google'));
    expect(screen.queryByRole('alert')).toBeNull();
  },
);
test('Google reports an incomplete flow', async () => {
  clerkMock.startSSOFlow.mockResolvedValueOnce({ createdSessionId: null });
  await renderWithProviders(<SignInScreen />);
  await fireEvent.press(screen.getByTestId('auth-google'));
  expect(
    screen.getByText(
      'Tài khoản cần thêm bước xác minh. Vui lòng liên hệ hỗ trợ.',
    ),
  ).toBeOnTheScreen();
});
test('Google network errors are friendly', async () => {
  clerkMock.startSSOFlow.mockRejectedValueOnce(new TypeError('offline'));
  await renderWithProviders(<SignInScreen />);
  await fireEvent.press(screen.getByTestId('auth-google'));
  expect(
    screen.getByText('Không kết nối được. Kiểm tra mạng rồi thử lại.'),
  ).toBeOnTheScreen();
});
test.each(['android', 'web'] as const)(
  'Google SSO is available on %s',
  async (platform) => {
    const previous = Platform.OS;
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: platform,
    });
    try {
      const result = await renderWithProviders(<SignInScreen />);
      await fireEvent.press(screen.getByTestId('auth-google'));
      expect(clerkMock.startSSOFlow).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: 'oauth_google' }),
      );
      if (platform === 'android')
        expect(WebBrowser.warmUpAsync).toHaveBeenCalled();
      await result.unmount();
      if (platform === 'android')
        expect(WebBrowser.coolDownAsync).toHaveBeenCalled();
    } finally {
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: previous,
      });
    }
  },
);

test('web sign-up has the custom-flow CAPTCHA container required by Clerk', async () => {
  const previous = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  try {
    await renderWithProviders(<SignInScreen />);
    expect(screen.getByTestId('auth-captcha')).toHaveProp(
      'nativeID',
      'clerk-captcha',
    );
  } finally {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: previous,
    });
  }
});

describe('device lock', () => {
  afterEach(() => jest.restoreAllMocks());
  /** The seed session signs in: a person with a store and no PIN, so nothing is asked of them. */
  const noPin = () =>
    installPeople({
      'test-clerk-token': {
        me: buildMe({
          userId: 'user_test',
          name: null,
          memberships: [{ storeId: 'store_test' }],
        }),
      },
    });
  const enterCode = async () => {
    await fireEvent.changeText(screen.getByTestId('auth-code'), '424242');
    await fireEvent.press(screen.getByTestId('auth-verify-code'));
  };

  test.each(['signIn', 'signUp'] as const)(
    'a completed email %s lifts it',
    async (mode) => {
      noPin();
      useDeviceLock.getState().lock();
      await codeScreen(mode);
      await enterCode();
      await waitFor(() => expect(useDeviceLock.getState().locked).toBe(false));
      expect(
        mode === 'signIn'
          ? clerkMock.signIn.finalize
          : clerkMock.signUp.finalize,
      ).toHaveBeenCalledTimes(1);
    },
  );

  test('a wrong code, an incomplete verification or a failed finalize keep it', async () => {
    useDeviceLock.getState().lock();
    clerkMock.signIn.emailCode.verifyCode.mockResolvedValueOnce({
      error: { code: 'form_code_incorrect' },
    });
    await codeScreen();
    await enterCode();
    clerkMock.signIn.emailCode.verifyCode.mockResolvedValueOnce({
      error: null,
    });
    await enterCode();
    clerkMock.signIn.finalize.mockResolvedValueOnce({
      error: { code: 'network_error' },
    });
    await enterCode();
    expect(useDeviceLock.getState().locked).toBe(true);
  });
});
