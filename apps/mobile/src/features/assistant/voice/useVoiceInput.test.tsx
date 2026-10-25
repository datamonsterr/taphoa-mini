import { act, renderHook } from '@testing-library/react-native';

import { setAnalyticsSink } from '@/lib/analytics';
import { speechMock } from '@/test/speech';

import { useVoiceInput } from './useVoiceInput';

const mod = speechMock.module;

const captured: { event: string; props: unknown }[] = [];

beforeEach(() => {
  speechMock.reset();
  captured.length = 0;
  setAnalyticsSink({
    capture: (event, props) => captured.push({ event, props }),
  });
});

afterEach(() => {
  setAnalyticsSink(null);
  jest.useRealTimers();
});

async function setup(language: 'vi' | 'en' = 'vi') {
  const onPartial = jest.fn();
  const onFinal = jest.fn();
  const hook = await renderHook(() =>
    useVoiceInput({ language, onPartial, onFinal }),
  );
  return { ...hook, onPartial, onFinal };
}

async function startAndListen(hook: Awaited<ReturnType<typeof setup>>) {
  await act(async () => {
    await hook.result.current.start();
  });
  await act(() => speechMock.emitStart());
}

test('is available when recognition is available, unavailable otherwise', async () => {
  expect((await setup()).result.current.available).toBe(true);
  speechMock.setAvailable(false);
  expect((await setup()).result.current.available).toBe(false);
});

test('is unavailable when the module throws', async () => {
  mod.isRecognitionAvailable.mockImplementation(() => {
    throw new Error('native module missing');
  });
  expect((await setup()).result.current.available).toBe(false);
});

test('start asks permission and starts vi-VN with interim results', async () => {
  const hook = await setup('vi');
  await startAndListen(hook);
  expect(mod.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(mod.start).toHaveBeenCalledWith(
    expect.objectContaining({
      lang: 'vi-VN',
      interimResults: true,
      continuous: true,
      requiresOnDeviceRecognition: false,
    }),
  );
  expect(hook.result.current.listening).toBe(true);
});

test('uses en-US, on-device recognition and punctuation when supported', async () => {
  speechMock.setOnDevice(true);
  const hook = await setup('en');
  await startAndListen(hook);
  expect(mod.start).toHaveBeenCalledWith(
    expect.objectContaining({
      lang: 'en-US',
      requiresOnDeviceRecognition: true,
      addsPunctuation: true,
    }),
  );
});

test('permission denied sets error and never starts', async () => {
  speechMock.setPermission(false);
  const hook = await setup();
  await act(async () => {
    await hook.result.current.start();
  });
  expect(hook.result.current.error).toBe('permission');
  expect(mod.start).not.toHaveBeenCalled();
  expect(hook.result.current.listening).toBe(false);
});

test('a permission error code from the engine maps to permission', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(() => speechMock.emitError('not-allowed'));
  await act(() => speechMock.emitEnd());
  expect(hook.result.current.error).toBe('permission');
  expect(hook.onFinal).not.toHaveBeenCalled();
});

test('asks permission only once after it was granted', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(() => speechMock.emitEnd());
  await startAndListen(hook);
  expect(mod.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(mod.start).toHaveBeenCalledTimes(2);
});

test('shows partials live and delivers the final on stop, never before', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(() => speechMock.emitResult('mua hai'));
  expect(hook.result.current.partial).toBe('mua hai');
  expect(hook.onPartial).toHaveBeenLastCalledWith('mua hai');
  await act(() => speechMock.emitResult('mua hai chai nước', false));
  expect(hook.onFinal).not.toHaveBeenCalled();

  await act(() => hook.result.current.stop());
  expect(mod.stop).toHaveBeenCalledTimes(1);
  await act(() => speechMock.emitResult('mua hai chai nước', true));
  await act(() => speechMock.emitEnd());

  expect(hook.onFinal).toHaveBeenCalledTimes(1);
  expect(hook.onFinal).toHaveBeenCalledWith('mua hai chai nước');
  expect(hook.result.current.listening).toBe(false);
  expect(hook.result.current.partial).toBe('');
});

test('joins several final segments of one hold', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(() => speechMock.emitResult('xin chào', true));
  await act(() => speechMock.emitResult('cửa hàng'));
  expect(hook.result.current.partial).toBe('xin chào cửa hàng');
  await act(() => speechMock.emitResult('cửa hàng', true));
  await act(() => hook.result.current.stop());
  await act(() => speechMock.emitEnd());
  expect(hook.onFinal).toHaveBeenCalledWith('xin chào cửa hàng');
});

test('falls back to the last partial when no final arrives', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(() => speechMock.emitResult('tồn kho'));
  await act(() => hook.result.current.stop());
  await act(() => speechMock.emitEnd());
  expect(hook.onFinal).toHaveBeenCalledWith('tồn kho');
});

test('cancel aborts without onFinal and without a result', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(() => speechMock.emitResult('bỏ qua'));
  await act(() => hook.result.current.cancel());
  expect(mod.abort).toHaveBeenCalledTimes(1);
  await act(() => speechMock.emitError('aborted'));
  await act(() => speechMock.emitEnd());
  expect(hook.onFinal).not.toHaveBeenCalled();
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.listening).toBe(false);
  expect(hook.result.current.partial).toBe('');
});

test('releasing before permission resolves starts nothing', async () => {
  let grant: (value: unknown) => void = () => {};
  mod.requestPermissionsAsync.mockReturnValueOnce(
    new Promise((resolve) => {
      grant = resolve;
    }),
  );
  const hook = await setup();
  let pending: Promise<void> = Promise.resolve();
  await act(() => {
    pending = hook.result.current.start();
  });
  await act(() => hook.result.current.stop());
  await act(async () => {
    grant({ granted: true, status: 'granted' });
    await pending;
  });
  expect(mod.start).not.toHaveBeenCalled();
  expect(captured).toHaveLength(0);
});

test('ignores a second start while listening', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(async () => {
    await hook.result.current.start();
  });
  expect(mod.start).toHaveBeenCalledTimes(1);
});

test('other engine errors set error, deliver nothing and report ok false', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(() => speechMock.emitError('network'));
  await act(() => speechMock.emitEnd());
  expect(hook.result.current.error).toBe('failed');
  expect(hook.onFinal).not.toHaveBeenCalled();
  expect(captured).toEqual([
    {
      event: 'voice_input_used',
      props: { duration_ms: expect.any(Number), language: 'vi-VN', ok: false },
    },
  ]);
});

test('no-speech is an empty result, not an error', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(() => speechMock.emitError('no-speech'));
  await act(() => speechMock.emitEnd());
  expect(hook.result.current.error).toBeNull();
  expect(hook.onFinal).not.toHaveBeenCalled();
  expect(captured[0]?.props).toMatchObject({ ok: false });
});

test('start clears an earlier error', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(() => speechMock.emitError('network'));
  await act(() => speechMock.emitEnd());
  expect(hook.result.current.error).toBe('failed');
  await startAndListen(hook);
  expect(hook.result.current.error).toBeNull();
});

test('a throwing start surfaces failed', async () => {
  mod.start.mockImplementation(() => {
    throw new Error('boom');
  });
  const hook = await setup();
  await act(async () => {
    await hook.result.current.start();
  });
  expect(hook.result.current.error).toBe('failed');
  expect(hook.result.current.listening).toBe(false);
});

test('captures voice_input_used once per hold with duration and language', async () => {
  jest.useFakeTimers({ now: 1_000 });
  const hook = await setup('en');
  await startAndListen(hook);
  jest.setSystemTime(3_500);
  await act(() => speechMock.emitResult('two apples', true));
  await act(() => hook.result.current.stop());
  await act(() => speechMock.emitEnd());
  await act(() => speechMock.emitEnd());
  expect(captured).toEqual([
    {
      event: 'voice_input_used',
      props: { duration_ms: 2500, language: 'en-US', ok: true },
    },
  ]);
});

test('empty transcript reports ok false and skips onFinal', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(() => speechMock.emitResult('  ', true));
  await act(() => hook.result.current.stop());
  await act(() => speechMock.emitEnd());
  expect(hook.onFinal).not.toHaveBeenCalled();
  expect(captured[0]?.props).toMatchObject({ ok: false });
});

test('cancel records no analytics event', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await act(() => hook.result.current.cancel());
  await act(() => speechMock.emitEnd());
  expect(captured).toHaveLength(0);
});

test('unmounting while listening aborts the recognizer', async () => {
  const hook = await setup();
  await startAndListen(hook);
  await hook.unmount();
  expect(mod.abort).toHaveBeenCalledTimes(1);
});

test('unmounting while idle does not touch the recognizer', async () => {
  const hook = await setup();
  await hook.unmount();
  expect(mod.abort).not.toHaveBeenCalled();
});

test('stop and cancel while idle do nothing', async () => {
  const hook = await setup();
  await act(() => hook.result.current.stop());
  await act(() => hook.result.current.cancel());
  expect(mod.stop).not.toHaveBeenCalled();
  expect(mod.abort).not.toHaveBeenCalled();
});
