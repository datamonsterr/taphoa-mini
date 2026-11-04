import { render, screen } from '@testing-library/react-native';

import { useSettingsStore } from '@/stores/settings';

import { ErrorNotice } from './ErrorNotice';

describe('an HTTP refusal is mapped by status, never shown as server text (#167)', () => {
  const texts: [number, RegExp][] = [
    [403, /không có quyền/],
    [404, /Không tìm thấy/],
    [409, /đã thay đổi/],
    [422, /chưa hợp lệ/],
  ];
  test.each(texts)('status %d', async (status, text) => {
    await render(
      <ErrorNotice
        error={{ code: 'http', status, message: 'forbidden: store mismatch' }}
        onRetry={jest.fn()}
      />,
    );
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText(/store mismatch/)).toBeNull();
    expect(screen.getByTestId('assistant-retry')).toBeTruthy();
  });

  test('a 400 says what to do, in Vietnamese', async () => {
    await render(
      <ErrorNotice error={{ code: 'http', status: 400 }} onRetry={jest.fn()} />,
    );
    expect(
      screen.getByText('Thông tin chưa hợp lệ. Kiểm tra lại rồi thử lại.'),
    ).toBeTruthy();
  });

  test('English shows the English sentence', async () => {
    useSettingsStore.setState({ language: 'en' });
    await render(
      <ErrorNotice error={{ code: 'http', status: 403 }} onRetry={jest.fn()} />,
    );
    expect(screen.getByText('You are not allowed to do this.')).toBeTruthy();
  });
});
