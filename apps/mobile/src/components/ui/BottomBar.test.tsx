import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test/render';
import { colors } from '@/theme';

import { BottomBar, CameraFab, NavPill } from './BottomBar';

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

test('CameraFab is a 64px accent button labelled Mở camera', async () => {
  const onPress = jest.fn();
  await renderWithProviders(<CameraFab onPress={onPress} />);
  const fab = screen.getByRole('button', { name: 'Mở camera' });
  expect(flat(fab)).toMatchObject({
    width: 64,
    backgroundColor: colors.accent,
  });
  await fireEvent.press(fab);
  expect(onPress).toHaveBeenCalledTimes(1);
});

test.each([
  ['inventory', 'Kho'],
  ['dashboard', 'Báo cáo'],
  ['account', 'Tài khoản'],
] as const)('current tab %s is filled ink', async (current, name) => {
  await renderWithProviders(<NavPill current={current} onSelect={jest.fn()} />);
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  const selected = screen.getByRole('tab', { name });
  expect(selected).toBeSelected();
  expect(flat(selected)).toMatchObject({ backgroundColor: colors.ink });
  expect(screen.getAllByRole('tab', { selected: false })).toHaveLength(2);
});

test('tapping a tab reports its id', async () => {
  const onSelect = jest.fn();
  await renderWithProviders(
    <NavPill current="inventory" onSelect={onSelect} />,
  );
  await fireEvent.press(screen.getByRole('tab', { name: 'Báo cáo' }));
  await fireEvent.press(screen.getByRole('tab', { name: 'Tài khoản' }));
  expect(onSelect.mock.calls.map(([t]) => t)).toEqual(['dashboard', 'account']);
});

test('BottomBar combines FAB and pill', async () => {
  const onCameraPress = jest.fn();
  await renderWithProviders(
    <BottomBar
      current="account"
      onSelect={jest.fn()}
      onCameraPress={onCameraPress}
    />,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Mở camera' }));
  expect(onCameraPress).toHaveBeenCalled();
  expect(screen.getByRole('tab', { name: 'Tài khoản' })).toBeSelected();
});
