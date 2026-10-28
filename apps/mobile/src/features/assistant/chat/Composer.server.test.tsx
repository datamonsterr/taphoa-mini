import { act, fireEvent, screen } from '@testing-library/react-native';

import { setApiTransport } from '@/lib/api/client';
import { audioMock } from '@/test/audio';
import { createMockFetch } from '@/test/mock/fetch';
import { renderWithProviders } from '@/test/render';
import { speechMock } from '@/test/speech';

import { uploadClipsAsBlobs } from '../../voice/testing';
import { Composer } from './Composer';

beforeEach(() => {
  audioMock.reset();
  speechMock.reset();
  process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT = '1';
  uploadClipsAsBlobs();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  process.env.EXPO_PUBLIC_VOICE_SERVER_CHAT = '0';
});

const input = () => screen.getByTestId('assistant-input');

async function hold(ms = 1200) {
  jest.useFakeTimers({ advanceTimers: true });
  await fireEvent(screen.getByTestId('voice-button'), 'pressIn');
  await act(() => jest.advanceTimersByTimeAsync(ms));
  await fireEvent(screen.getByTestId('voice-button'), 'pressOut');
}

test('shows three dots in the input until the transcript fills it, and never sends', async () => {
  let release: () => void = () => {};
  const real = createMockFetch();
  setApiTransport((request, init) =>
    String(request instanceof Request ? request.url : request).endsWith(
      '/v1/voice/utterances',
    )
      ? new Promise((resolve) => {
          release = () => resolve(real(request, init));
        })
      : real(request, init),
  );
  const onSend = jest.fn(() => true);
  await renderWithProviders(<Composer streaming={false} onSend={onSend} />);
  expect(screen.queryByTestId('assistant-transcribing')).toBeNull();
  await hold();
  await act(async () => {});
  expect(screen.getByTestId('assistant-transcribing')).toHaveTextContent(
    '• • •',
  );
  expect(input().props.placeholder).toBe('• • •');
  expect(input().props.accessibilityHint).toBe('Đang chuyển lời nói thành chữ');
  await act(async () => release());
  await act(async () => {});
  expect(screen.queryByTestId('assistant-transcribing')).toBeNull();
  expect(input().props.value).toBe('hai lon coca với một lon pepsi');
  expect(input().props.placeholder).toBe('Hỏi trợ lý về cửa hàng…');
  expect(onSend).not.toHaveBeenCalled();
});

test('the transcript is appended to what was already typed', async () => {
  await renderWithProviders(<Composer streaming={false} onSend={jest.fn()} />);
  await fireEvent.changeText(input(), 'Hôm nay');
  await hold();
  await act(async () => {});
  expect(input().props.value).toBe('Hôm nay hai lon coca với một lon pepsi');
});

test('a transcript is sent as a voice turn when the seller presses send', async () => {
  const onSend = jest.fn(() => true);
  await renderWithProviders(<Composer streaming={false} onSend={onSend} />);
  await hold();
  await act(async () => {});
  await fireEvent.press(screen.getByTestId('assistant-send'));
  expect(onSend).toHaveBeenCalledWith(
    'hai lon coca với một lon pepsi',
    'voice',
  );
});

test('offline the input never keeps the dots', async () => {
  setApiTransport(async () => {
    throw new TypeError('Network request failed');
  });
  await renderWithProviders(<Composer streaming={false} onSend={jest.fn()} />);
  await hold();
  await act(async () => {});
  expect(screen.queryByTestId('assistant-transcribing')).toBeNull();
  expect(input().props.value).toBe('');
});
