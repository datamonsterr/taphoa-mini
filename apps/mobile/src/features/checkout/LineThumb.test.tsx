import { screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { LineThumb } from './LineThumb';

test('shows a package glyph without a photo', async () => {
  await renderWithProviders(<LineThumb />);
  expect(screen.getByTestId('icon-Package')).toBeOnTheScreen();
});

test('shows the photo when a url is given', async () => {
  await renderWithProviders(<LineThumb uri="https://img.test/a.jpg" />);
  expect(screen.queryByTestId('icon-Package')).toBeNull();
});
