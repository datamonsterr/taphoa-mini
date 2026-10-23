import { screen } from '@testing-library/react-native';

import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';
import { colors, typography } from '@/theme';

import { MoneyText } from './MoneyText';

const flat = (style: unknown) =>
  Object.assign({}, ...[style].flat(5).filter(Boolean));

test('formats VND with the price variant by default', async () => {
  await renderWithProviders(<MoneyText amount={12000} />);
  const text = screen.getByText('12.000đ');
  expect(flat(text.props.style)).toMatchObject({
    fontSize: typography.price.fontSize,
    color: colors.ink,
  });
});

test('applies the variant and colour', async () => {
  await renderWithProviders(
    <MoneyText amount={49500} variant="total" color={colors.success} />,
  );
  expect(flat(screen.getByText('49.500đ').props.style)).toMatchObject({
    fontSize: 56,
    color: colors.success,
  });
});

test('follows the user text size', async () => {
  useSettingsStore.setState({ fontScale: 1.5 });
  await renderWithProviders(<MoneyText amount={12000} />);
  expect(flat(screen.getByText('12.000đ').props.style)).toMatchObject({
    fontSize: typography.price.fontSize! * 1.5,
  });
});
