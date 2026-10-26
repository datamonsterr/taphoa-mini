import { fireEvent, screen, within } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';

import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';
import { camera, colors } from '@/theme';

import type { NextStepChipData } from './chip';
import { NextStepStrip } from './NextStepStrip';

const device: NextStepChipData = {
  id: 'receipt_detected',
  kind: 'receipt_detected',
  title: 'Hóa đơn nhập hàng',
  subtitle: 'Trợ lý đọc từng dòng',
  source: 'device',
  action: { type: 'receipt' },
};
const server: NextStepChipData = {
  id: 'restock',
  kind: 'restock',
  title: 'Cần nhập hàng',
  source: 'server',
  action: {
    type: 'chat',
    prompt_vi: 'Tôi nên nhập thêm hàng gì?',
    context: { screen: 'camera', next_step_id: 'restock' },
  },
};

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

test('renders nothing without chips', async () => {
  await renderWithProviders(<NextStepStrip chips={[]} onPress={jest.fn()} />);
  expect(screen.queryByTestId('next-step-strip')).toBeNull();
});

test('is one horizontal row that snaps per chip', async () => {
  await renderWithProviders(
    <NextStepStrip chips={[device, server]} onPress={jest.fn()} />,
  );
  const strip = screen.getByTestId('next-step-strip');
  expect(strip.props.horizontal).toBe(true);
  expect(strip.props.showsHorizontalScrollIndicator).toBe(false);
  expect(strip.props.decelerationRate).toBe('fast');
  expect(strip.props.disableIntervalMomentum).toBe(true);
  expect(strip.props.snapToInterval).toBeGreaterThan(0);
  expect(strip.props.snapToAlignment).toBe('start');
});

test('shows title and subtitle on a labelled button of at least 48 dp', async () => {
  await renderWithProviders(
    <NextStepStrip chips={[device, server]} onPress={jest.fn()} />,
  );
  const chip = screen.getByRole('button', {
    name: 'Hóa đơn nhập hàng. Trợ lý đọc từng dòng',
  });
  expect(within(chip).getByText('Hóa đơn nhập hàng')).toBeOnTheScreen();
  expect(within(chip).getByText('Trợ lý đọc từng dòng')).toBeOnTheScreen();
  expect(flat(chip).minHeight).toBeGreaterThanOrEqual(48);
  // A chip without a subtitle is labelled by its title alone.
  expect(
    screen.getByRole('button', { name: 'Cần nhập hàng' }),
  ).toBeOnTheScreen();
});

test('on-device chips look different from server chips', async () => {
  await renderWithProviders(
    <NextStepStrip chips={[device, server]} onPress={jest.fn()} />,
  );
  expect(
    flat(screen.getByTestId('next-step-chip-receipt_detected')),
  ).toMatchObject({ backgroundColor: colors.accent });
  expect(flat(screen.getByTestId('next-step-chip-restock'))).toMatchObject({
    backgroundColor: camera.glass,
  });
});

test('a tap gives selection haptic feedback and reports the chip and its position', async () => {
  const onPress = jest.fn();
  await renderWithProviders(
    <NextStepStrip chips={[device, server]} onPress={onPress} />,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Cần nhập hàng' }));
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  expect(onPress).toHaveBeenCalledWith(server, 1);
});

test('the strip is named for screen readers in the app language', async () => {
  useSettingsStore.setState({ language: 'en' });
  await renderWithProviders(
    <NextStepStrip chips={[server]} onPress={jest.fn()} />,
  );
  expect(screen.getByLabelText('Suggested next steps')).toBeOnTheScreen();
});
