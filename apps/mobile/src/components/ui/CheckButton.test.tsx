import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';
import { useSettingsStore } from '@/stores/settings';
import { colors, size } from '@/theme';

import { CheckButton } from './CheckButton';

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

test('success fill = received', async () => {
  const onPress = jest.fn();
  await renderWithProviders(
    <CheckButton
      variant="success"
      accessibilityLabel="Đã nhận tiền"
      onPress={onPress}
    />,
  );
  const button = screen.getByRole('button', { name: 'Đã nhận tiền' });
  expect(flat(button)).toMatchObject({ backgroundColor: colors.success });
  await fireEvent.press(button);
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('ink fill = save, block', async () => {
  await renderWithProviders(
    <CheckButton
      variant="ink"
      accessibilityLabel="Chốt sổ hôm nay"
      onPress={jest.fn()}
      block
    />,
  );
  expect(flat(screen.getByRole('button'))).toMatchObject({
    backgroundColor: colors.ink,
    alignSelf: 'stretch',
  });
});

test('disabled', async () => {
  const onPress = jest.fn();
  await renderWithProviders(
    <CheckButton
      variant="ink"
      accessibilityLabel="Lưu"
      onPress={onPress}
      disabled
    />,
  );
  const button = screen.getByRole('button');
  expect(button).toBeDisabled();
  await fireEvent.press(button);
  expect(onPress).not.toHaveBeenCalled();
});

test('xl is the 80px pay button with a 32px check', async () => {
  await renderWithProviders(
    <CheckButton
      variant="success"
      accessibilityLabel="Đã nhận tiền"
      onPress={jest.fn()}
      block
      xl
    />,
  );
  expect(flat(screen.getByRole('button'))).toMatchObject({ minHeight: 80 });
  expect(screen.getByTestId('icon-Check').props.size).toBe(32);
});

test('elder mode grows the button to the 80px tap target', async () => {
  useSettingsStore.setState({ elderMode: true });
  await renderWithProviders(
    <CheckButton variant="ink" accessibilityLabel="Lưu" onPress={jest.fn()} />,
  );
  expect(flat(screen.getByRole('button', { name: 'Lưu' }))).toMatchObject({
    minHeight: size.tapXl,
  });
});

test('an optional label shows next to the check', async () => {
  await renderWithProviders(
    <CheckButton
      variant="ink"
      accessibilityLabel="Xong, hiểu lời vừa nói"
      label="Xong"
      onPress={jest.fn()}
    />,
  );
  expect(screen.getByText('Xong')).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Xong, hiểu lời vừa nói' }),
  ).toBeOnTheScreen();
});
