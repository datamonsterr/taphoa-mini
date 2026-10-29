import { act, renderHook } from '@testing-library/react-native';

import {
  addClerkSession,
  clerkMock,
  resetClerkMock,
  setClerkState,
} from '@/test/clerk';

import { useLockOutgoingSession } from './useLockOutgoingSession';

const pathsCalled = (spy: jest.SpyInstance) =>
  spy.mock.calls.map(([request]: [Request]) => ({
    path: new URL(request.url).pathname,
    auth: request.headers.get('authorization'),
  }));

let network: jest.SpyInstance;
beforeEach(() => {
  resetClerkMock();
  network = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(null, { status: 204 }));
});
afterEach(() => jest.restoreAllMocks());

test('locks the person who stops being active, with their own token', async () => {
  addClerkSession({ id: 'sess_b', userId: 'user_b', email: 'b@example.com' });
  await renderHook(() => useLockOutgoingSession());
  expect(network).not.toHaveBeenCalled();
  await act(async () => {
    setClerkState({ userId: 'user_b', sessionId: 'sess_b' });
  });
  expect(pathsCalled(network)).toEqual([
    { path: '/v1/me/pin/lock', auth: 'Bearer test-clerk-token' },
  ]);
  // Back to the first person: the second one is locked, with their token.
  await act(async () => {
    setClerkState({ userId: 'user_test', sessionId: 'sess_test' });
  });
  expect(pathsCalled(network)[1]).toEqual({
    path: '/v1/me/pin/lock',
    auth: 'Bearer token_sess_b',
  });
});

test('a signed-out moment in the middle of a switch locks nobody extra', async () => {
  await renderHook(() => useLockOutgoingSession());
  await act(async () => {
    setClerkState({ isSignedIn: false, userId: null, sessionId: null });
  });
  await act(async () => {
    setClerkState({
      isSignedIn: true,
      userId: 'user_test',
      sessionId: 'sess_test',
    });
  });
  expect(network).not.toHaveBeenCalled();
  expect(clerkMock.getToken).not.toHaveBeenCalled();
});
