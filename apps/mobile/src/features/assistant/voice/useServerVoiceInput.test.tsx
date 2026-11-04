import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { setAnalyticsSink } from '@/lib/analytics';
import { setApiTransport } from '@/lib/api/client';
import { audioMock } from '@/test/audio';
import { createMockFetch } from '@/test/mock/fetch';
import { setVoiceQuotaExceeded } from '@/test/mock';

import { uploadClipsAsBlobs } from '../../voice/testing';
import { useServerVoiceInput } from './useServerVoiceInput';

const events: { event: string; props: unknown }[] = [];

beforeEach(() => {
  audioMock.reset();
  events.length = 0;
  setAnalyticsSink({
    capture: (event, props) => events.push({ event, props }),
  });
  uploadClipsAsBlobs();
  jest.useFakeTimers({ now: 5_000_000, advanceTimers: true });
});
afterEach(() => {
  jest.restoreAllMocks();
  setAnalyticsSink(null);
});

async function setup(language: 'vi' | 'en' = 'vi') {
  const onFinal = jest.fn();
  const onUnavailable = jest.fn();
  const hook = await renderHook(() =>
    useServerVoiceInput({ language, onFinal, onUnavailable }),
  );
  return { hook, onFinal, onUnavailable };
}

async function hold(
  hook: Awaited<ReturnType<typeof setup>>['hook'],
  ms = 1500,
) {
  await act(async () => {
    await hook.result.current.start();
  });
  await act(() => jest.advanceTimersByTimeAsync(ms));
  await act(async () => hook.result.current.stop());
}

const offline = () =>
  setApiTransport(async () => {
    throw new TypeError('Network request failed');
  });

test('release uploads the recording as mode=transcribe and delivers the transcript', async () => {
  audioMock.setNextUri('file:///cache/two-line-sale.m4a');
  const { hook, onFinal } = await setup();
  await hold(hook);
  await act(async () => {});
  expect(onFinal).toHaveBeenCalledWith('hai lon coca với một lon pepsi');
  expect(hook.result.current.transcribing).toBe(false);
  expect(events).toEqual([
    {
      event: 'voice_input_used',
      props: {
        duration_ms: expect.any(Number),
        language: 'vi-VN',
        ok: true,
        engine: 'server',
      },
    },
  ]);
});

test('the request is a transcribe-mode upload with the chat entry', async () => {
  const seen: Request[] = [];
  const real = createMockFetch();
  setApiTransport(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    seen.push(request.clone());
    return real(input, init);
  });
  const { hook } = await setup('en');
  await hold(hook);
  await act(async () => {});
  const upload = seen.find((r) => r.url.endsWith('/v1/voice/utterances'))!;
  const form = (await upload.formData()) as unknown as {
    get: (key: string) => unknown;
  };
  expect(form.get('mode')).toBe('transcribe');
  expect(form.get('language')).toBe('en');
  expect(JSON.parse(String(form.get('context')))).toEqual({
    entry: 'chat',
    screen: 'assistant',
  });
});

test('shows transcribing between the release and the transcript', async () => {
  let release: () => void = () => {};
  const real = createMockFetch();
  setApiTransport(
    (input, init) =>
      new Promise((resolve) => {
        release = () => resolve(real(input, init));
      }),
  );
  const { hook, onFinal } = await setup();
  await hold(hook);
  expect(hook.result.current.transcribing).toBe(true);
  expect(hook.result.current.listening).toBe(false);
  await act(async () => release());
  await act(async () => {});
  expect(hook.result.current.transcribing).toBe(false);
  expect(onFinal).toHaveBeenCalledTimes(1);
});

test('nothing heard is not an error and fills nothing', async () => {
  audioMock.setNextUri('file:///cache/no-speech.m4a');
  const { hook, onFinal } = await setup();
  await hold(hook);
  await act(async () => {});
  expect(onFinal).not.toHaveBeenCalled();
  expect(hook.result.current.error).toBeNull();
  expect(events[0]!.props).toMatchObject({ ok: false, engine: 'server' });
});

test('offline asks the caller to fall back to the device', async () => {
  offline();
  const { hook, onFinal, onUnavailable } = await setup();
  await hold(hook);
  await act(async () => {});
  expect(onUnavailable).toHaveBeenCalledTimes(1);
  expect(onFinal).not.toHaveBeenCalled();
  expect(hook.result.current.error).toBe('unavailable');
});

test('a 503 voice_unavailable falls back the same way', async () => {
  setApiTransport(
    async () =>
      new Response(
        JSON.stringify({ error: 'down', code: 'voice_unavailable' }),
        {
          status: 503,
          headers: { 'content-type': 'application/json' },
        },
      ),
  );
  const { hook, onUnavailable } = await setup();
  await hold(hook);
  await act(async () => {});
  expect(onUnavailable).toHaveBeenCalledTimes(1);
});

test('the daily quota is a plain failure, not a fallback', async () => {
  setVoiceQuotaExceeded(true);
  const { hook, onUnavailable } = await setup();
  await hold(hook);
  await act(async () => {});
  expect(onUnavailable).not.toHaveBeenCalled();
  expect(hook.result.current.error).toBe('failed');
});

test('a refused microphone reports permission', async () => {
  audioMock.setPermission('prompt-denied');
  const { hook } = await setup();
  await act(async () => {
    await hook.result.current.start();
  });
  expect(hook.result.current.error).toBe('permission');
  expect(hook.result.current.listening).toBe(false);
});

test('a release before the recorder started records nothing', async () => {
  let answer: (value: never) => void = () => {};
  const { requestRecordingPermissionsAsync } = jest.requireMock('expo-audio');
  requestRecordingPermissionsAsync.mockReturnValue(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  const { hook, onFinal } = await setup();
  let started: Promise<void> = Promise.resolve();
  await act(async () => {
    started = hook.result.current.start();
  });
  await act(async () => hook.result.current.stop());
  await act(async () => {
    answer({ granted: true } as never);
    await started;
  });
  await act(async () => {});
  expect(onFinal).not.toHaveBeenCalled();
  expect(hook.result.current.listening).toBe(false);
});

test('cancel drops a transcript that arrives late', async () => {
  let release: () => void = () => {};
  const real = createMockFetch();
  setApiTransport(
    (input, init) =>
      new Promise((resolve) => {
        release = () => resolve(real(input, init));
      }),
  );
  const { hook, onFinal } = await setup();
  await hold(hook);
  await act(async () => hook.result.current.cancel());
  await act(async () => release());
  await act(async () => {});
  expect(onFinal).not.toHaveBeenCalled();
  expect(hook.result.current.transcribing).toBe(false);
});

test('is unavailable on the web, which has no m4a recorder', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  expect((await setup()).hook.result.current.available).toBe(false);
});
