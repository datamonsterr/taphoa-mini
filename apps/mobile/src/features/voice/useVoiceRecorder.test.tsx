import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { audioMock } from '@/test/audio';

import {
  MAX_SECONDS,
  SILENCE_MS,
  useVoiceRecorder,
  VOICE_RECORDING,
} from './useVoiceRecorder';

import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';

beforeEach(() => {
  audioMock.reset();
  jest.useFakeTimers({ now: 1_000_000 });
});

async function setup(options: Parameters<typeof useVoiceRecorder>[0] = {}) {
  const onFinished = jest.fn();
  const hook = await renderHook(() =>
    useVoiceRecorder({ onFinished, ...options }),
  );
  return { hook, onFinished };
}

const meter = (db: number) => act(async () => audioMock.setMetering(db));
const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

test('records AAC m4a at 16 kHz mono 32 kbps with metering', () => {
  expect(VOICE_RECORDING).toMatchObject({
    extension: '.m4a',
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 32000,
    isMeteringEnabled: true,
  });
});

test('asks for the microphone on first use, then records for at most 30 s', async () => {
  const { hook } = await setup();
  let started = false;
  await act(async () => {
    started = await hook.result.current.start();
  });
  expect(started).toBe(true);
  expect(requestRecordingPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(setAudioModeAsync).toHaveBeenCalledWith({
    allowsRecording: true,
    playsInSilentMode: true,
  });
  expect(audioMock.recorder.record).toHaveBeenCalledWith({
    forDuration: MAX_SECONDS,
  });
  expect(hook.result.current.status).toBe('recording');
});

test('does not ask again when the permission is already granted', async () => {
  audioMock.setPermission('granted');
  const { hook } = await setup();
  await act(async () => void (await hook.result.current.start()));
  expect(requestRecordingPermissionsAsync).not.toHaveBeenCalled();
  expect(hook.result.current.status).toBe('recording');
});

test('a refused permission ends in denied and never records', async () => {
  audioMock.setPermission('prompt-denied');
  const { hook } = await setup();
  let started = true;
  await act(async () => {
    started = await hook.result.current.start();
  });
  expect(started).toBe(false);
  expect(hook.result.current.status).toBe('denied');
  expect(audioMock.recorder.record).not.toHaveBeenCalled();
});

test('a recorder that throws ends in error', async () => {
  audioMock.recorder.prepareToRecordAsync.mockRejectedValue(new Error('busy'));
  const { hook } = await setup();
  await act(async () => void (await hook.result.current.start()));
  expect(hook.result.current.status).toBe('error');
});

test('stop delivers the clip named after the recorded file', async () => {
  audioMock.setNextUri('file:///cache/ambiguous.m4a');
  const { hook, onFinished } = await setup();
  await act(async () => void (await hook.result.current.start()));
  await advance(1200);
  let clip;
  await act(async () => {
    clip = await hook.result.current.stop();
  });
  expect(clip).toMatchObject({
    uri: 'file:///cache/ambiguous.m4a',
    name: 'ambiguous.m4a',
    type: 'audio/mp4',
    durationMs: 1200,
  });
  expect(onFinished).toHaveBeenCalledWith(clip);
  expect(hook.result.current.status).toBe('idle');
});

test('a tap shorter than a third of a second is not an utterance', async () => {
  const { hook, onFinished } = await setup();
  await act(async () => void (await hook.result.current.start()));
  await advance(100);
  await act(async () => void (await hook.result.current.stop()));
  expect(onFinished).not.toHaveBeenCalled();
});

test('stops by itself after 2 s of silence once speech was heard', async () => {
  const { hook, onFinished } = await setup();
  await act(async () => void (await hook.result.current.start()));
  await advance(500);
  await meter(-12);
  await advance(300);
  expect(hook.result.current.level).toBeGreaterThan(0.7);
  await meter(-58);
  await advance(SILENCE_MS - 400);
  expect(onFinished).not.toHaveBeenCalled();
  await advance(600);
  expect(onFinished).toHaveBeenCalledTimes(1);
  expect(audioMock.recorder.stop).toHaveBeenCalledTimes(1);
});

test('silence before any speech never stops the recording', async () => {
  const { hook, onFinished } = await setup();
  await act(async () => void (await hook.result.current.start()));
  await meter(-60);
  await advance(10_000);
  expect(onFinished).not.toHaveBeenCalled();
  expect(hook.result.current.status).toBe('recording');
});

test('talking again resets the silence timer', async () => {
  const { hook, onFinished } = await setup();
  await act(async () => void (await hook.result.current.start()));
  await meter(-10);
  await advance(300);
  await meter(-60);
  await advance(1500);
  await meter(-10);
  await advance(300);
  await meter(-60);
  await advance(1500);
  expect(onFinished).not.toHaveBeenCalled();
  await advance(800);
  expect(onFinished).toHaveBeenCalledTimes(1);
});

test('the 30 s cap ends a recording that never goes quiet', async () => {
  const { hook, onFinished } = await setup();
  await act(async () => void (await hook.result.current.start()));
  await advance(29_900);
  expect(onFinished).not.toHaveBeenCalled();
  expect(hook.result.current.elapsedMs).toBeGreaterThan(29_000);
  await advance(200);
  expect(onFinished).toHaveBeenCalledTimes(1);
});

test('a recorder that stops by itself finishes the clip', async () => {
  const { hook, onFinished } = await setup();
  await act(async () => void (await hook.result.current.start()));
  await advance(1000);
  await act(async () => void (await audioMock.recorder.stop()));
  await advance(200);
  expect(onFinished).toHaveBeenCalledTimes(1);
  expect(hook.result.current.status).toBe('idle');
});

test('cancel throws the audio away', async () => {
  const { hook, onFinished } = await setup();
  await act(async () => void (await hook.result.current.start()));
  await advance(1000);
  await act(async () => void (await hook.result.current.cancel()));
  expect(onFinished).not.toHaveBeenCalled();
  expect(audioMock.recorder.stop).toHaveBeenCalled();
  expect(hook.result.current.status).toBe('idle');
});

test('cancel during the permission prompt stops a recording that would start late', async () => {
  let answer: (
    value: Awaited<ReturnType<typeof requestRecordingPermissionsAsync>>,
  ) => void = () => {};
  jest.mocked(requestRecordingPermissionsAsync).mockReturnValue(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  const { hook, onFinished } = await setup();
  let started: Promise<boolean> = Promise.resolve(false);
  await act(async () => {
    started = hook.result.current.start();
  });
  await act(async () => void (await hook.result.current.cancel()));
  await act(async () => {
    answer({
      granted: true,
      status: 'granted',
      canAskAgain: true,
      expires: 'never',
    } as never);
    await started;
  });
  expect(audioMock.recorder.record).not.toHaveBeenCalled();
  expect(onFinished).not.toHaveBeenCalled();
  expect(hook.result.current.status).toBe('idle');
});

test('unmounting stops the microphone', async () => {
  const { hook } = await setup();
  await act(async () => void (await hook.result.current.start()));
  await hook.unmount();
  expect(audioMock.recorder.stop).toHaveBeenCalled();
});

describe('fixture clip', () => {
  test('stands in for the microphone: no permission, no recorder', async () => {
    const { hook, onFinished } = await setup({ fixture: 'two-line-sale.m4a' });
    await act(async () => void (await hook.result.current.start()));
    expect(hook.result.current.status).toBe('recording');
    expect(requestRecordingPermissionsAsync).not.toHaveBeenCalled();
    await act(async () => void (await hook.result.current.stop()));
    expect(onFinished).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'two-line-sale.m4a', fixture: true }),
    );
    expect(audioMock.recorder.record).not.toHaveBeenCalled();
  });
});

test('the web has no m4a recorder without a fixture', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  expect((await setup()).hook.result.current.available).toBe(false);
  expect(
    (await setup({ fixture: 'a.m4a' })).hook.result.current.available,
  ).toBe(true);
});
