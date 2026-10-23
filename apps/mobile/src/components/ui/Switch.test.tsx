import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';

import { Switch } from './Switch';

const LABEL = 'Chế độ người lớn tuổi';

test.each([true, false])('checked=%s', async (value) => {
  await renderWithProviders(
    <Switch
      value={value}
      onValueChange={jest.fn()}
      accessibilityLabel={LABEL}
    />,
  );
  const sw = screen.getByRole('switch', { name: LABEL });
  if (value) expect(sw).toBeChecked();
  else expect(sw).not.toBeChecked();
});

test('toggles via onValueChange', async () => {
  const onValueChange = jest.fn();
  const view = await renderWithProviders(
    <Switch
      value={false}
      onValueChange={onValueChange}
      accessibilityLabel={LABEL}
    />,
  );
  await fireEvent.press(screen.getByRole('switch'));
  expect(onValueChange).toHaveBeenLastCalledWith(true);
  await view.rerender(
    <Switch value onValueChange={onValueChange} accessibilityLabel={LABEL} />,
  );
  await fireEvent.press(screen.getByRole('switch'));
  expect(onValueChange).toHaveBeenLastCalledWith(false);
});

test('disabled ignores presses', async () => {
  const onValueChange = jest.fn();
  await renderWithProviders(
    <Switch
      value={false}
      onValueChange={onValueChange}
      accessibilityLabel={LABEL}
      disabled
    />,
  );
  await fireEvent.press(screen.getByRole('switch'));
  expect(onValueChange).not.toHaveBeenCalled();
});
