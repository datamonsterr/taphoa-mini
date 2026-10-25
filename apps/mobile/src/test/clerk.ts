import { useSyncExternalStore, type ReactNode } from 'react';

type AuthState = {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  sessionId: string | null;
};
let state: AuthState = {
  isLoaded: true,
  isSignedIn: true,
  userId: 'user_test',
  sessionId: 'sess_test',
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getClerkState = () => state;
export const setClerkState = (patch: Partial<AuthState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};
const success = async () => ({ error: null });
export const clerkMock = {
  getToken: jest.fn<Promise<string | null>, [{ skipCache?: boolean }?]>(),
  signOut: jest.fn(),
  setActive: jest.fn(),
  startSSOFlow: jest.fn(),
  sessions: [
    { id: 'sess_test', user: { id: 'user_test' } },
    { id: 'sess_other', user: { id: 'user_other' } },
  ],
  signIn: {
    status: 'needs_first_factor',
    create: jest.fn(),
    reset: jest.fn(),
    emailCode: { sendCode: jest.fn(), verifyCode: jest.fn() },
    finalize: jest.fn(),
  },
  signUp: {
    status: 'missing_requirements',
    create: jest.fn(),
    reset: jest.fn(),
    verifications: { sendEmailCode: jest.fn(), verifyEmailCode: jest.fn() },
    finalize: jest.fn(),
  },
};
export function resetClerkMock() {
  setClerkState({
    isLoaded: true,
    isSignedIn: true,
    userId: 'user_test',
    sessionId: 'sess_test',
  });
  clerkMock.getToken.mockReset().mockResolvedValue('test-clerk-token');
  clerkMock.setActive
    .mockReset()
    .mockImplementation(async () => setClerkState({ isSignedIn: true }));
  clerkMock.signOut
    .mockReset()
    .mockImplementation(async () =>
      setClerkState({ isSignedIn: false, userId: null, sessionId: null }),
    );
  clerkMock.startSSOFlow.mockReset().mockResolvedValue({
    createdSessionId: 'sess_google',
    setActive: clerkMock.setActive,
  });
  for (const resource of [clerkMock.signIn, clerkMock.signUp]) {
    resource.create.mockReset().mockImplementation(success);
    resource.reset.mockReset().mockImplementation(success);
    resource.finalize
      .mockReset()
      .mockImplementation(
        async (options?: { navigate?: () => Promise<void> }) => {
          setClerkState({
            isSignedIn: true,
            userId: 'user_test',
            sessionId: 'sess_test',
          });
          await options?.navigate?.();
          return { error: null };
        },
      );
  }
  clerkMock.signIn.status = 'needs_first_factor';
  clerkMock.signUp.status = 'missing_requirements';
  clerkMock.signIn.emailCode.sendCode.mockReset().mockImplementation(success);
  clerkMock.signIn.emailCode.verifyCode
    .mockReset()
    .mockImplementation(async () => {
      clerkMock.signIn.status = 'complete';
      return { error: null };
    });
  clerkMock.signUp.verifications.sendEmailCode
    .mockReset()
    .mockImplementation(success);
  clerkMock.signUp.verifications.verifyEmailCode
    .mockReset()
    .mockImplementation(async () => {
      clerkMock.signUp.status = 'complete';
      return { error: null };
    });
}
export const useAuth = () => ({
  ...useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  ),
  getToken: clerkMock.getToken,
  signOut: clerkMock.signOut,
});
export const useClerk = () => ({
  signOut: clerkMock.signOut,
  setActive: clerkMock.setActive,
  client: { sessions: clerkMock.sessions },
});
export const useSignIn = () => ({
  signIn: clerkMock.signIn,
  errors: {},
  fetchStatus: 'idle',
});
export const useSignUp = () => ({
  signUp: clerkMock.signUp,
  errors: {},
  fetchStatus: 'idle',
});
export const useSSO = () => ({ startSSOFlow: clerkMock.startSSOFlow });
export const ClerkProvider = ({ children }: { children: ReactNode }) =>
  children;
