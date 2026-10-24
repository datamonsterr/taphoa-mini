import { Platform } from 'react-native';

import { testSession } from '@/test/session';

import {
  initialSession,
  selectCanEnroll,
  selectIsLead,
  selectSignedIn,
  SESSION_STORAGE_KEY,
  useSessionStore,
} from './session';

const secureValues = (
  jest.requireMock('expo-secure-store') as { __values: Map<string, string> }
).__values;

beforeEach(() => {
  secureValues.clear();
  useSessionStore.setState(initialSession);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('setSession keeps the session in memory and in the secure store', async () => {
  useSessionStore.getState().setSession(testSession());
  await flush();
  expect(useSessionStore.getState()).toMatchObject({
    hydrated: true,
    session: { access_token: 'test-access-token' },
  });
  expect(JSON.parse(secureValues.get(SESSION_STORAGE_KEY)!)).toMatchObject({
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
  });
});

test('hydrate restores a stored session', async () => {
  secureValues.set(SESSION_STORAGE_KEY, JSON.stringify(testSession()));
  await useSessionStore.getState().hydrate();
  expect(useSessionStore.getState().hydrated).toBe(true);
  expect(useSessionStore.getState().session?.refresh_token).toBe(
    'test-refresh-token',
  );
});

test.each(['not json', '{"access_token":1}', 'null'])(
  'hydrate treats %s as signed out',
  async (stored) => {
    secureValues.set(SESSION_STORAGE_KEY, stored);
    await useSessionStore.getState().hydrate();
    expect(useSessionStore.getState()).toMatchObject({
      hydrated: true,
      session: null,
    });
  },
);

test('a sign-in during hydration is not overwritten by the stored value', async () => {
  const stale = { ...testSession(), access_token: 'stale' };
  secureValues.set(SESSION_STORAGE_KEY, JSON.stringify(stale));
  const hydrating = useSessionStore.getState().hydrate();
  useSessionStore.setState({ session: testSession() });
  await hydrating;
  expect(useSessionStore.getState().session?.access_token).toBe(
    'test-access-token',
  );
});

test('hydrate runs once', async () => {
  useSessionStore.setState({ hydrated: true });
  secureValues.set(SESSION_STORAGE_KEY, JSON.stringify(testSession()));
  await useSessionStore.getState().hydrate();
  expect(useSessionStore.getState().session).toBeNull();
});

test('clear forgets the session everywhere', async () => {
  useSessionStore.getState().setSession(testSession(), 'CODE');
  await flush();
  useSessionStore.getState().clear();
  await flush();
  expect(useSessionStore.getState()).toMatchObject({
    session: null,
    pendingRecoveryCode: null,
  });
  expect(secureValues.has(SESSION_STORAGE_KEY)).toBe(false);
});

test('a recovery code blocks the app until it is acknowledged, and survives a token rotation', () => {
  const store = useSessionStore.getState();
  store.setSession(testSession(), '7KQ4-MZ2P');
  expect(selectSignedIn(useSessionStore.getState())).toBe(false);
  useSessionStore
    .getState()
    .setSession({ ...testSession(), access_token: 'rotated' });
  expect(useSessionStore.getState().pendingRecoveryCode).toBe('7KQ4-MZ2P');
  useSessionStore.getState().acknowledgeRecoveryCode();
  expect(selectSignedIn(useSessionStore.getState())).toBe(true);
});

test('selectors: signed in needs a session; Lead needs the lead role', () => {
  expect(selectSignedIn(useSessionStore.getState())).toBe(false);
  expect(selectIsLead(useSessionStore.getState())).toBe(false);
  const seller = {
    ...testSession(),
    member: { ...testSession().member, role: 'seller' as const },
  };
  useSessionStore.getState().setSession(seller);
  expect(selectIsLead(useSessionStore.getState())).toBe(false);
  useSessionStore.getState().setSession(testSession());
  expect(selectIsLead(useSessionStore.getState())).toBe(true);
});

/** Jest's React Native environment has no `localStorage`; a Map-backed one stands in. */
function installLocalStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
  return storage;
}

describe('on the web', () => {
  const original = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'web';
    installLocalStorage();
  });
  afterEach(() => {
    Platform.OS = original;
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  test('the session lives in localStorage, not the secure store', async () => {
    useSessionStore.getState().setSession(testSession());
    await flush();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toContain(
      'test-access-token',
    );
    expect(secureValues.size).toBe(0);

    useSessionStore.setState(initialSession);
    await useSessionStore.getState().hydrate();
    expect(useSessionStore.getState().session?.access_token).toBe(
      'test-access-token',
    );

    useSessionStore.getState().clear();
    await flush();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});

test('selectCanEnroll: Lead and can_enroll Sellers only', () => {
  const base = testSession();
  const as = (role: 'lead' | 'seller', can_enroll: boolean) =>
    selectCanEnroll({
      ...useSessionStore.getState(),
      session: { ...base, member: { ...base.member, role, can_enroll } },
    });
  expect(as('lead', false)).toBe(true);
  expect(as('seller', true)).toBe(true);
  expect(as('seller', false)).toBe(false);
  expect(
    selectCanEnroll({ ...useSessionStore.getState(), session: null }),
  ).toBe(false);
});
