import { render, screen } from '@testing-library/react-native';

import HomeScreen from '../src/app';

test('renders the Vietnamese home screen and placeholder sales button', async () => {
  await render(<HomeScreen />);

  expect(
    screen.getByRole('header', { name: 'Tạp Hóa Mini' }),
  ).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Bán hàng' })).toBeDisabled();
});
