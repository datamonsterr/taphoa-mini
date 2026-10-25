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

/** A Clerk session on this device; `getToken` is per session, like the real resource. */
export type MockClerkSession = {
  id: string;
  status: 'active' | 'pending' | 'ended' | 'removed';
  user: {
    id: string;
    primaryEmailAddress: { emailAddress: string } | null;
  } | null;
  publicUserData: { identifier: string };
  getToken: jest.Mock<Promise<string | null>, [{ skipCache?: boolean }?]>;
};
const defaultSession = (): MockClerkSession => ({
  id: 'sess_test',
  status: 'active',
  user: {
    id: 'user_test',
    primaryEmailAddress: { emailAddress: 'coba@example.com' },
  },
  publicUserData: { identifier: 'coba@example.com' },
  // The signed-in session shares the hook's token source.
  getToken: clerkMock.getToken,
});
export const clerkMock = {
  getToken: jest.fn<Promise<string | null>, [{ skipCache?: boolean }?]>(),
  signOut: jest.fn(),
  setActive: jest.fn(),
  startSSOFlow: jest.fn(),
  sessions: [] as MockClerkSession[],
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
/** Adds another person to this device. Its token is `token_<id>` unless `token` says otherwise. */
export function addClerkSession(options: {
  id: string;
  userId: string;
  email: string | null;
  status?: MockClerkSession['status'];
  token?: string | null;
}): MockClerkSession {
  const session: MockClerkSession = {
    id: options.id,
    status: options.status ?? 'active',
    user: {
      id: options.userId,
      primaryEmailAddress: options.email
        ? { emailAddress: options.email }
        : null,
    },
    publicUserData: { identifier: options.email ?? '' },
    getToken: jest.fn(async () =>
      options.token === undefined ? `token_${options.id}` : options.token,
    ),
  };
  clerkMock.sessions.push(session);
  setClerkState({});
  return session;
}
const signedIn = () =>
  clerkMock.sessions.filter(({ status }) => status === 'active');
export function resetClerkMock() {
  clerkMock.sessions.splice(0, clerkMock.sessions.length, defaultSession());
  setClerkState({
    isLoaded: true,
    isSignedIn: true,
    userId: 'user_test',
    sessionId: 'sess_test',
  });
  clerkMock.getToken.mockReset().mockResolvedValue('test-clerk-token');
  // Like Clerk: the target becomes the signed-in person, an unknown id (SSO) only signs in.
  clerkMock.setActive
    .mockReset()
    .mockImplementation(
      async (params?: { session?: string | { id: string } | null }) => {
        const id =
          typeof params?.session === 'string'
            ? params.session
            : params?.session?.id;
        const target = signedIn().find((session) => session.id === id);
        setClerkState(
          target?.user
            ? { isSignedIn: true, userId: target.user.id, sessionId: target.id }
            : { isSignedIn: true },
        );
      },
    );
  // Like Clerk 6: another session is removed alone; the active one (or the last one) leaves a
  // signed-out state, and nothing else becomes active by itself.
  clerkMock.signOut
    .mockReset()
    .mockImplementation(async (options?: { sessionId?: string }) => {
      const id = options?.sessionId;
      if (!id || signedIn().length <= 1)
        for (const session of clerkMock.sessions) session.status = 'removed';
      else {
        const target = clerkMock.sessions.find((session) => session.id === id);
        if (target) target.status = 'removed';
      }
      const current = getClerkState().sessionId;
      const left = current && signedIn().some(({ id }) => id === current);
      setClerkState(
        left ? {} : { isSignedIn: false, userId: null, sessionId: null },
      );
    });
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
  client: { sessions: clerkMock.sessions, signedInSessions: signedIn() },
});
export const useSessionList = () => {
  const { isLoaded } = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  return {
    isLoaded,
    sessions: [...clerkMock.sessions],
    setActive: clerkMock.setActive,
  };
};
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
