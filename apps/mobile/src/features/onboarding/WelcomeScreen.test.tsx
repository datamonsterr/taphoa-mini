import { screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { WelcomeScreen } from './WelcomeScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
}));

test('welcome follows the board: full subtitle, scan card, create and join pills, plain sign-out link', async () => {
  await renderWithProviders(<WelcomeScreen />);
  expect(
    screen.getByRole('header', { name: 'Tạp Hóa Mini' }),
  ).toBeOnTheScreen();
  expect(
    screen.getByText('Bán hàng bằng một tấm ảnh. Chụp, bấm cộng, đưa mã QR.'),
  ).toBeOnTheScreen();
  expect(
    screen.getByText('10.000', { includeHiddenElements: true }),
  ).toBeTruthy();
  expect(screen.getByTestId('icon-Plus')).toBeOnTheScreen();
  expect(screen.getByTestId('icon-QrCode')).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Tạo cửa hàng' }),
  ).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Tham gia cửa hàng' }),
  ).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Đăng xuất' })).toBeOnTheScreen();
});
