import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { isLoadFailure, RouteErrorBoundary } from './RouteErrorBoundary';

const LOAD_MESSAGE = 'Không tải được màn hình. Kiểm tra mạng rồi thử lại.';

describe('isLoadFailure', () => {
  test.each([
    'Loading module http://localhost:8131/_expo/static/js/web/verify-code-3e18.js failed.',
    'Failed to fetch dynamically imported module: /x.js',
    'Importing a module script failed.',
    'Network request failed',
    'Loading chunk 12 failed.',
  ])('%s is a failed load', (message) => {
    expect(isLoadFailure(new Error(message))).toBe(true);
  });
  test('a ChunkLoadError is a failed load whatever its message', () => {
    const error = new Error('boom');
    error.name = 'ChunkLoadError';
    expect(isLoadFailure(error)).toBe(true);
  });
  test('other errors and non-errors are not', () => {
    expect(
      isLoadFailure(new Error('Cannot read properties of undefined')),
    ).toBe(false);
    expect(isLoadFailure(undefined)).toBe(false);
    expect(isLoadFailure('Loading module failed')).toBe(false);
  });
});

describe('RouteErrorBoundary', () => {
  const failed = new Error(
    'Loading module http://localhost/_expo/static/js/web/verify-code-1.js failed.',
  );

  test('a failed route load says so in Vietnamese and offers a retry', async () => {
    const retry = jest.fn(async () => undefined);
    await render(<RouteErrorBoundary error={failed} retry={retry} />);
    expect(screen.getByText(LOAD_MESSAGE)).toBeOnTheScreen();
    expect(screen.getByText('Không tải được màn hình')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('any other crash gets its own message, not the network one', async () => {
    await render(
      <RouteErrorBoundary
        error={new TypeError('x is not a function')}
        retry={jest.fn(async () => undefined)}
      />,
    );
    expect(
      screen.getByText('Màn hình này gặp lỗi. Thử lại, hoặc mở lại ứng dụng.'),
    ).toBeOnTheScreen();
    expect(screen.queryByText(LOAD_MESSAGE)).toBeNull();
  });

  test('on the web the retry reloads the page, because a failed import stays rejected', async () => {
    const previous = Platform.OS;
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'web',
    });
    const reload = jest.fn();
    const original = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload },
    });
    try {
      const retry = jest.fn(async () => undefined);
      await render(<RouteErrorBoundary error={failed} retry={retry} />);
      await fireEvent.press(screen.getByRole('button', { name: 'Thử lại' }));
      expect(reload).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: previous,
      });
      if (original) Object.defineProperty(window, 'location', original);
    }
  });
});
