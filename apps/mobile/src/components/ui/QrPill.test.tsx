import { fireEvent, screen } from '@testing-library/react-native';

import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';
import { size } from '@/theme';

import { QrPill } from './QrPill';

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

test('default label from the board; press fires', async () => {
  const onPress = jest.fn();
  await renderWithProviders(<QrPill onPress={onPress} />);
  await fireEvent.press(
    screen.getByRole('button', { name: 'Hiện mã QR thanh toán' }),
  );
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('shows an optional visible label', async () => {
  await renderWithProviders(<QrPill onPress={jest.fn()} label="49.500đ" />);
  expect(screen.getByText('49.500đ')).toBeOnTheScreen();
});

test('disabled', async () => {
  const onPress = jest.fn();
  await renderWithProviders(<QrPill onPress={onPress} disabled />);
  const pill = screen.getByRole('button');
  expect(pill).toBeDisabled();
  await fireEvent.press(pill);
  expect(onPress).not.toHaveBeenCalled();
});

test('elder mode grows the pill to the 80px tap target', async () => {
  useSettingsStore.setState({ elderMode: true });
  await renderWithProviders(<QrPill onPress={jest.fn()} />);
  expect(
    flat(screen.getByRole('button', { name: 'Hiện mã QR thanh toán' })),
  ).toMatchObject({ minHeight: size.tapXl });
});
