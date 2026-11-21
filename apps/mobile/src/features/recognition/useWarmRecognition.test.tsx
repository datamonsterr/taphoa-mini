import { renderHook, waitFor } from '@testing-library/react-native';

import { warmRecognition } from '@/lib/api/warmRecognition';
import {
  canWarmRecognition,
  requestRecognitionWarmup,
  resetWarmRecognitionThrottle,
  useWarmRecognition,
} from './useWarmRecognition';

const mockState = { membership: null as { store: { id: string } } | null };

jest.mock('@clerk/expo', () => ({ useAuth: () => ({ isSignedIn: true }) }));
jest.mock('@/features/auth/useMembership', () => ({
  useMembership: () => mockState.membership,
}));
jest.mock('@/lib/online', () => ({ useOnline: () => true }));
jest.mock('@/lib/api/warmRecognition', () => ({ warmRecognition: jest.fn() }));

const warm = jest.mocked(warmRecognition);

beforeEach(() => {
  mockState.membership = { store: { id: 'store' } };
  warm.mockReset().mockResolvedValue();
  resetWarmRecognitionThrottle();
});

test('warms once on mount and not on rerender while the screen stays mounted', async () => {
  const hook = await renderHook(() => useWarmRecognition());
  hook.rerender(undefined);
  await waitFor(() => expect(warm).toHaveBeenCalledTimes(1));
  hook.unmount();
});

test('waits for membership to load, then warms once while the screen stays mounted', async () => {
  mockState.membership = null;
  const hook = await renderHook(() => useWarmRecognition());
  await waitFor(() => expect(warm).not.toHaveBeenCalled());

  mockState.membership = { store: { id: 'store' } };
  hook.rerender(undefined);
  await waitFor(() => expect(warm).toHaveBeenCalledTimes(1));

  hook.rerender(undefined);
  expect(warm).toHaveBeenCalledTimes(1);
  hook.unmount();
});

test('allows one call per 60 seconds across screens', () => {
  requestRecognitionWarmup(true, warm, 100_000);
  requestRecognitionWarmup(true, warm, 159_999);
  expect(warm).toHaveBeenCalledTimes(1);
  requestRecognitionWarmup(true, warm, 160_000);
  expect(warm).toHaveBeenCalledTimes(2);
});

test.each([
  [
    'signed out',
    { signedIn: false, locked: false, hasStore: true, online: true },
  ],
  [
    'without an active store',
    { signedIn: true, locked: false, hasStore: false, online: true },
  ],
  ['offline', { signedIn: true, locked: false, hasStore: true, online: false }],
  ['locked', { signedIn: true, locked: true, hasStore: true, online: true }],
])('does not warm when %s', (_condition, input) => {
  expect(canWarmRecognition(input)).toBe(false);
  requestRecognitionWarmup(canWarmRecognition(input), warm, 100_000);
  expect(warm).not.toHaveBeenCalled();
});

test('ignores a rejected warm request without throwing', async () => {
  const rejected = jest.fn().mockRejectedValue(new Error('unavailable'));
  expect(() => requestRecognitionWarmup(true, rejected, 100_000)).not.toThrow();
  await waitFor(() => expect(rejected).toHaveBeenCalledTimes(1));
});
