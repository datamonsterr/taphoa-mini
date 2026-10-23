import { Pencil } from 'lucide-react-native';
import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';
import { colors } from '@/theme';

import { CircleButton } from './CircleButton';

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

test('is a labelled 56px button and fires onPress', async () => {
  const onPress = jest.fn();
  await renderWithProviders(
    <CircleButton
      icon={Pencil}
      accessibilityLabel="Sửa giá"
      onPress={onPress}
    />,
  );
  const button = screen.getByRole('button', { name: 'Sửa giá' });
  expect(flat(button)).toMatchObject({
    width: 56,
    height: 56,
    backgroundColor: colors.surfaceSoft,
  });
  await fireEvent.press(button);
  expect(onPress).toHaveBeenCalledTimes(1);
});

test.each([
  ['ink', colors.ink],
  ['accent', colors.accent],
] as const)('variant %s', async (variant, bg) => {
  await renderWithProviders(
    <CircleButton icon={Pencil} accessibilityLabel="x" variant={variant} />,
  );
  expect(flat(screen.getByRole('button'))).toMatchObject({
    backgroundColor: bg,
  });
});

test('large is 64 with float shadow', async () => {
  await renderWithProviders(
    <CircleButton icon={Pencil} accessibilityLabel="x" large floating />,
  );
  expect(flat(screen.getByRole('button'))).toMatchObject({
    width: 64,
    height: 64,
    shadowOpacity: 0.14,
  });
});

test('disabled blocks presses and reports state', async () => {
  const onPress = jest.fn();
  await renderWithProviders(
    <CircleButton
      icon={Pencil}
      accessibilityLabel="x"
      disabled
      onPress={onPress}
    />,
  );
  const button = screen.getByRole('button', { name: 'x' });
  expect(button).toBeDisabled();
  await fireEvent.press(button);
  expect(onPress).not.toHaveBeenCalled();
});

test('press in and out do not throw', async () => {
  await renderWithProviders(
    <CircleButton icon={Pencil} accessibilityLabel="x" />,
  );
  const button = screen.getByRole('button');
  await fireEvent(button, 'pressIn');
  await fireEvent(button, 'pressOut');
});
