import { renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { useSessionStore } from '@/stores/session';
import { testSession } from '@/test/session';
import * as pushModule from './push';
import * as promptTiming from './promptTiming';
import { usePushRegistration } from './usePushRegistration';

jest.mock('./push');

describe('usePushRegistration', () => {
  const originalPlatform = Platform.OS;

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    Platform.OS = 'android';
    useSessionStore.setState({
      session: testSession(),
      hydrated: true,
      pendingRecoveryCode: null,
    });
    (pushModule.getPushPermission as jest.Mock).mockResolvedValue({
      status: 'undetermined',
      granted: false,
      canAskAgain: true,
    });
    (pushModule.requestPushPermission as jest.Mock).mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: true,
    });
    (pushModule.registerForPush as jest.Mock).mockResolvedValue('mock-token');
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
  });

  test('first open: increments opens, does not prompt, does not register', async () => {
    renderHook(() => usePushRegistration());

    await waitFor(async () => {
      const state = await promptTiming.getPromptState();
      expect(state.opens).toBe(1);
    });

    expect(pushModule.requestPushPermission).not.toHaveBeenCalled();
    expect(pushModule.registerForPush).not.toHaveBeenCalled();
    const state = await promptTiming.getPromptState();
    expect(state.asked).toBe(false);
  });

  test('second open: prompts, marks asked, registers on grant', async () => {
    // Simulate first open already happened
    await promptTiming.incrementOpens();

    renderHook(() => usePushRegistration());

    await waitFor(() => {
      expect(pushModule.requestPushPermission).toHaveBeenCalled();
      expect(pushModule.registerForPush).toHaveBeenCalled();
    });

    const state = await promptTiming.getPromptState();
    expect(state.opens).toBe(2);
    expect(state.asked).toBe(true);
  });

  test('second open: if permission is denied, does not register but still marks asked', async () => {
    await promptTiming.incrementOpens();
    (pushModule.requestPushPermission as jest.Mock).mockResolvedValue({
      status: 'denied',
      granted: false,
      canAskAgain: false,
    });

    renderHook(() => usePushRegistration());

    await waitFor(() => {
      expect(pushModule.requestPushPermission).toHaveBeenCalled();
    });

    expect(pushModule.registerForPush).not.toHaveBeenCalled();
    const state = await promptTiming.getPromptState();
    expect(state.opens).toBe(2);
    expect(state.asked).toBe(true);
  });

  test('already granted: registers without prompting', async () => {
    (pushModule.getPushPermission as jest.Mock).mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: true,
    });

    renderHook(() => usePushRegistration());

    await waitFor(() => {
      expect(pushModule.registerForPush).toHaveBeenCalled();
    });

    expect(pushModule.requestPushPermission).not.toHaveBeenCalled();
    const state = await promptTiming.getPromptState();
    expect(state.opens).toBe(1);
  });

  test('web is no-op', async () => {
    Platform.OS = 'web';

    renderHook(() => usePushRegistration());

    await new Promise((r) => setTimeout(r, 50));
    expect(pushModule.getPushPermission).not.toHaveBeenCalled();
    expect(pushModule.requestPushPermission).not.toHaveBeenCalled();
    expect(pushModule.registerForPush).not.toHaveBeenCalled();
    const state = await promptTiming.getPromptState();
    expect(state.opens).toBe(0);
  });

  test('not signed in is no-op', async () => {
    useSessionStore.setState({ session: null });

    renderHook(() => usePushRegistration());

    await new Promise((r) => setTimeout(r, 50));
    expect(pushModule.getPushPermission).not.toHaveBeenCalled();
    expect(pushModule.requestPushPermission).not.toHaveBeenCalled();
    expect(pushModule.registerForPush).not.toHaveBeenCalled();
    const state = await promptTiming.getPromptState();
    expect(state.opens).toBe(0);
  });

  test('cancels in-flight push registration on unmount', async () => {
    let resolvePermission!: (val: any) => void;
    (pushModule.getPushPermission as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolvePermission = resolve;
      }),
    );

    const hook = await renderHook(() => usePushRegistration());
    await hook.unmount();

    resolvePermission({ status: 'granted', granted: true, canAskAgain: true });
    expect(pushModule.registerForPush).not.toHaveBeenCalled();
  });

  test('cancels in-flight prompt request on unmount', async () => {
    await promptTiming.incrementOpens();
    let resolveRequest!: (val: any) => void;
    (pushModule.requestPushPermission as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const hook = await renderHook(() => usePushRegistration());
    await waitFor(() =>
      expect(pushModule.requestPushPermission).toHaveBeenCalled(),
    );
    // Before request resolves, markAsked has NOT been called
    let state = await promptTiming.getPromptState();
    expect(state.asked).toBe(false);

    await hook.unmount();

    resolveRequest({ status: 'granted', granted: true, canAskAgain: true });
    expect(pushModule.registerForPush).not.toHaveBeenCalled();
    state = await promptTiming.getPromptState();
    expect(state.asked).toBe(false);
  });

  test('catches error in syncPush, logs warning, and does not leave unhandled rejection', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await promptTiming.incrementOpens();
    (pushModule.requestPushPermission as jest.Mock).mockRejectedValueOnce(
      new Error('Native permission dialog crashed'),
    );

    renderHook(() => usePushRegistration());

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to sync push registration:'),
        expect.any(Error),
      );
    });

    const state = await promptTiming.getPromptState();
    // markAsked must NOT be called if request failed
    expect(state.asked).toBe(false);
    warnSpy.mockRestore();
  });
});
