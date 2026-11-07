import { fireEvent, render, screen } from '@testing-library/react-native';

import { useSettingsStore } from '@/stores/settings';

import type { ChatError } from '../chatReducer';
import { ErrorNotice } from './ErrorNotice';

const retryCodes: ChatError['code'][] = [
  'network',
  'busy',
  'interrupted',
  'timeout',
  'model_unavailable',
  'internal',
  'http',
];

test.each(retryCodes)('%s offers Retry', async (code) => {
  const onRetry = jest.fn();
  await render(<ErrorNotice error={{ code }} onRetry={onRetry} />);
  await fireEvent.press(screen.getByTestId('assistant-retry'));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alert')).toBeTruthy();
});

test('network and interrupted have their own text', async () => {
  const { rerender } = await render(
    <ErrorNotice error={{ code: 'network' }} onRetry={jest.fn()} />,
  );
  expect(screen.getByText(/Không kết nối được/)).toBeTruthy();
  await rerender(
    <ErrorNotice error={{ code: 'interrupted' }} onRetry={jest.fn()} />,
  );
  expect(screen.getByText(/bị gián đoạn/)).toBeTruthy();
});

test('a server message is shown in Vietnamese for other errors', async () => {
  await render(
    <ErrorNotice
      error={{ code: 'model_unavailable', message: 'Mô hình đang bận.' }}
      onRetry={jest.fn()}
    />,
  );
  expect(screen.getByText('Mô hình đang bận.')).toBeTruthy();
});

test('other errors fall back to the generic text', async () => {
  await render(
    <ErrorNotice error={{ code: 'internal' }} onRetry={jest.fn()} />,
  );
  expect(screen.getByText(/gặp sự cố/)).toBeTruthy();
});

test('quota shows the server message in Vietnamese and has no Retry', async () => {
  await render(
    <ErrorNotice
      error={{ code: 'quota', message: 'Bạn đã hết lượt trợ lý hôm nay.' }}
      onRetry={jest.fn()}
    />,
  );
  expect(screen.getByText('Bạn đã hết lượt trợ lý hôm nay.')).toBeTruthy();
  expect(screen.queryByTestId('assistant-retry')).toBeNull();
});

test('quota falls back to the fixed Vietnamese text without a message', async () => {
  await render(<ErrorNotice error={{ code: 'quota' }} onRetry={jest.fn()} />);
  expect(screen.getByText(/hết lượt trợ lý hôm nay/)).toBeTruthy();
});

test('quota in English shows the English text, not the server message', async () => {
  useSettingsStore.setState({ language: 'en' });
  await render(
    <ErrorNotice
      error={{ code: 'quota', message: 'Bạn đã hết lượt trợ lý hôm nay.' }}
      onRetry={jest.fn()}
    />,
  );
  expect(screen.getByText(/used today's assistant messages/)).toBeTruthy();
  expect(screen.queryByText(/Bạn đã hết/)).toBeNull();
  expect(screen.queryByTestId('assistant-retry')).toBeNull();
});

test('a busy server asks to try later, not to check the network (#158)', async () => {
  await render(<ErrorNotice error={{ code: 'busy' }} onRetry={jest.fn()} />);
  expect(
    screen.getByText('Trợ lý đang bận. Bạn thử lại sau ít phút nhé.'),
  ).toBeTruthy();
  expect(screen.queryByText(/Kiểm tra mạng/)).toBeNull();
});

test('a quota error without a server text says the daily limit is used up (#158)', async () => {
  await render(<ErrorNotice error={{ code: 'quota' }} onRetry={jest.fn()} />);
  expect(screen.getByText(/hết lượt trợ lý hôm nay/)).toBeTruthy();
  expect(screen.queryByTestId('assistant-retry')).toBeNull();
});
