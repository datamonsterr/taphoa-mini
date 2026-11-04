import NetInfo from '@react-native-community/netinfo';
import { act, renderHook } from '@testing-library/react-native';
import { onlineManager } from '@tanstack/react-query';

import { installOnlineManager, useOnline } from './online';

const emit = (isConnected: boolean | null) =>
  (NetInfo as unknown as { __emit: (s: unknown) => void }).__emit({
    isConnected,
  });

beforeAll(installOnlineManager);

test('onlineManager follows NetInfo and useOnline re-renders with it', async () => {
  const { result } = await renderHook(() => useOnline());
  expect(result.current).toBe(true);
  await act(async () => emit(false));
  expect(onlineManager.isOnline()).toBe(false);
  expect(result.current).toBe(false);
  await act(async () => emit(true));
  expect(result.current).toBe(true);
});

test('an unknown connection state counts as online', async () => {
  await act(async () => emit(false));
  await act(async () => emit(null));
  expect(onlineManager.isOnline()).toBe(true);
});

test('NetInfo reachability probing is switched off', () => {
  expect(NetInfo.configure).toHaveBeenCalledWith(
    expect.objectContaining({ reachabilityShouldRun: expect.any(Function) }),
  );
});
