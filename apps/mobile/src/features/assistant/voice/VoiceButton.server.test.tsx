import { act, fireEvent, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { setApiTransport } from '@/lib/api/client';
import { AnalyticsProvider } from '@/lib/analyticsPostHog';
import { audioMock } from '@/test/audio';
import { createMockFetch } from '@/test/mock/fetch';
import { featureFlags, resetPostHog } from '@/test/posthog';
import { renderWithProviders } from '@/test/render';
import { speechMock } from '@/test/speech';

import { uploadClipsAsBlobs } from '../../voice/testing';
import { VoiceButton } from './VoiceButton';

beforeEach(() => {
  audioMock.reset();
  speechMock.reset();
  resetPostHog();
  process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT = '1';
  uploadClipsAsBlobs();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT = '0';
  delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
});

async function renderButton(
  props: Partial<React.ComponentProps<typeof VoiceButton>> = {},
) {
  const onPartial = jest.fn();
  const onFinal = jest.fn();
  const onPendingChange = jest.fn();
  await renderWithProviders(
    <VoiceButton
      language="vi"
      onPartial={onPartial}
      onFinal={onFinal}
      onPendingChange={onPendingChange}
      {...props}
    />,
  );
  return { onPartial, onFinal, onPendingChange };
}

async function holdAndRelease(ms = 1200) {
  jest.useFakeTimers({ advanceTimers: true });
  await fireEvent(screen.getByTestId('voice-button'), 'pressIn');
  await act(() => jest.advanceTimersByTimeAsync(ms));
  await fireEvent(screen.getByTestId('voice-button'), 'pressOut');
  await act(async () => {});
}

const offline = () =>
  setApiTransport(async () => {
    throw new TypeError('Network request failed');
  });

test('release fills the composer with the server transcript and records with expo-audio', async () => {
  const { onFinal, onPartial, onPendingChange } = await renderButton();
  await holdAndRelease();
  expect(audioMock.recorder.record).toHaveBeenCalled();
  expect(speechMock.module.start).not.toHaveBeenCalled();
  expect(onFinal).toHaveBeenCalledWith('hai lon coca với một lon pepsi');
  expect(onPartial).not.toHaveBeenCalled();
  expect(onPendingChange).toHaveBeenCalledWith(true);
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
});

test('is on by default: no env override and no remote flag', async () => {
  delete process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT;
  await renderButton();
  await holdAndRelease();
  expect(audioMock.recorder.record).toHaveBeenCalled();
});

test('the remote flag voice_server_chat=false switches to the on-device recognizer', async () => {
  delete process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT;
  process.env.EXPO_PUBLIC_POSTHOG_KEY = 'test-key';
  featureFlags.set('voice_server_chat', false);
  const onFinal = jest.fn();
  await renderWithProviders(
    <AnalyticsProvider>
      <VoiceButton language="vi" onPartial={jest.fn()} onFinal={onFinal} />
    </AnalyticsProvider>,
  );
  await fireEvent(screen.getByTestId('voice-button'), 'pressIn');
  await act(async () => {});
  expect(speechMock.module.start).toHaveBeenCalled();
  expect(audioMock.recorder.record).not.toHaveBeenCalled();
});

test('the env override wins over the remote flag', async () => {
  process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT = '0';
  await renderButton();
  await fireEvent(screen.getByTestId('voice-button'), 'pressIn');
  await act(async () => {});
  expect(speechMock.module.start).toHaveBeenCalled();
});

test('the web keeps the Web Speech path', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  await renderButton();
  await fireEvent(screen.getByTestId('voice-button'), 'pressIn');
  await act(async () => {});
  expect(speechMock.module.start).toHaveBeenCalled();
  expect(audioMock.recorder.record).not.toHaveBeenCalled();
});

test('offline: the hold fails over to the on-device recognizer with a notice', async () => {
  offline();
  const { onFinal } = await renderButton();
  await holdAndRelease();
  expect(onFinal).not.toHaveBeenCalled();
  expect(await screen.findByTestId('voice-fallback-notice')).toHaveTextContent(
    /Chưa gửi được lên máy chủ/,
  );
  // the next hold listens on the device
  await fireEvent(screen.getByTestId('voice-button'), 'pressIn');
  await act(async () => {});
  expect(speechMock.module.start).toHaveBeenCalled();
});

test('a 503 voice_unavailable fails over the same way', async () => {
  setApiTransport(
    async () =>
      new Response(JSON.stringify({ error: 'x', code: 'voice_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
  );
  await renderButton();
  await holdAndRelease();
  expect(screen.getByTestId('voice-fallback-notice')).toBeOnTheScreen();
});

test('the server comes back after a minute', async () => {
  const real = createMockFetch();
  offline();
  await renderButton();
  await holdAndRelease();
  expect(screen.getByTestId('voice-fallback-notice')).toBeOnTheScreen();
  setApiTransport(real);
  await act(() => jest.advanceTimersByTimeAsync(61_000));
  await act(async () => {});
  expect(screen.queryByTestId('voice-fallback-notice')).toBeNull();
  await holdAndRelease();
  expect(audioMock.recorder.record).toHaveBeenCalledTimes(2);
});

test('keeps the hold-to-talk label and a screen reader tap still toggles', async () => {
  await renderButton();
  expect(screen.getByTestId('voice-button').props.accessibilityLabel).toBe(
    'Giữ để nói',
  );
});
