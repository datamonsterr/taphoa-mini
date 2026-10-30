import { act, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { LineThumb } from './LineThumb';

test('shows a package glyph without a photo', async () => {
  await renderWithProviders(<LineThumb />);
  expect(screen.getByTestId('icon-Package')).toBeOnTheScreen();
});

test('keeps the package glyph until the photo has loaded', async () => {
  await renderWithProviders(<LineThumb uri="https://img.test/a.jpg" />);
  expect(screen.getByTestId('icon-Package')).toBeOnTheScreen();
  await act(async () =>
    screen.getByTestId('line-photo').props.onLoad({ nativeEvent: {} }),
  );
  expect(screen.queryByTestId('icon-Package')).toBeNull();
});
