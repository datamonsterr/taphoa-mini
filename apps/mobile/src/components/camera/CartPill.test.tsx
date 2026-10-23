import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';
import { colors } from '@/theme';

import { CartPill } from './CartPill';

describe('CartPill', () => {
  it('empty: muted 0 and no total, per the Main board', async () => {
    await renderWithProviders(
      <CartPill count={0} total={0} onPress={jest.fn()} />,
    );
    expect(
      screen.getByRole('button', { name: 'Giỏ hàng trống' }),
    ).toBeOnTheScreen();
    expect(screen.queryByText('0đ')).toBeNull();
    expect(screen.queryByTestId('cart-count')).toBeNull();
    expect(screen.getByTestId('cart-empty')).toHaveTextContent('0');
    expect(screen.getByTestId('cart-empty')).toHaveStyle({
      color: colors.cameraMuted,
    });
  });

  it('shows count badge and formatted running total', async () => {
    await renderWithProviders(
      <CartPill count={2} total={25000} onPress={jest.fn()} />,
    );
    expect(
      screen.getByRole('button', { name: 'Giỏ hàng: 2 món, 25.000đ' }),
    ).toBeOnTheScreen();
    expect(screen.getByText('25.000đ')).toBeOnTheScreen();
    expect(screen.getByTestId('cart-count')).toHaveTextContent('2');
  });

  it('calls onPress', async () => {
    const onPress = jest.fn();
    await renderWithProviders(
      <CartPill count={2} total={25000} onPress={onPress} />,
    );
    await fireEvent.press(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
