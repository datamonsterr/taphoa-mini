import { fireEvent, screen } from '@testing-library/react-native';

import { Dimensions, StyleSheet, type ViewStyle } from 'react-native';

import { renderWithProviders } from '@/test/render';

import { Stepper } from './Stepper';

function setup(value: number) {
  const handlers = {
    onIncrement: jest.fn(),
    onDecrement: jest.fn(),
    onRemove: jest.fn(),
  };
  return { handlers, ui: <Stepper value={value} {...handlers} /> };
}

test('quantity above 1: minus decrements', async () => {
  const { ui, handlers } = setup(2);
  await renderWithProviders(ui);
  expect(screen.getByText('2')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Xóa' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Bớt một' }));
  expect(handlers.onDecrement).toHaveBeenCalledTimes(1);
  expect(handlers.onRemove).not.toHaveBeenCalled();
});

test('quantity 1: minus becomes trash and removes', async () => {
  const { ui, handlers } = setup(1);
  await renderWithProviders(ui);
  expect(screen.queryByRole('button', { name: 'Bớt một' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Xóa' }));
  expect(handlers.onRemove).toHaveBeenCalledTimes(1);
  expect(handlers.onDecrement).not.toHaveBeenCalled();
});

test('plus increments', async () => {
  const { ui, handlers } = setup(3);
  await renderWithProviders(ui);
  await fireEvent.press(screen.getByRole('button', { name: 'Thêm một' }));
  expect(handlers.onIncrement).toHaveBeenCalledTimes(1);
});

test('labels override the accessible names', async () => {
  const labels = {
    remove: 'Remove',
    decrement: 'One less',
    increment: 'One more',
    quantity: (n: number) => `Quantity ${n}`,
  };
  await renderWithProviders(
    <Stepper
      value={1}
      onIncrement={jest.fn()}
      onDecrement={jest.fn()}
      onRemove={jest.fn()}
      labels={labels}
    />,
  );
  expect(screen.getByRole('button', { name: 'Remove' })).toBeOnTheScreen();
  expect(screen.getByLabelText('Quantity 1')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'One more' })).toBeOnTheScreen();
});

describe('48 dp hit targets', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([320, 400])('both buttons >= 48 dp at width %i', async (width) => {
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width, height: 800, scale: 1, fontScale: 1 });
    const { ui } = setup(2);
    await renderWithProviders(ui);
    for (const name of ['Bớt một', 'Thêm một']) {
      const s = StyleSheet.flatten(
        screen.getByRole('button', { name }).props.style,
      ) as ViewStyle;
      expect(
        Math.max(Number(s.width ?? 0), Number(s.minWidth ?? 0)),
      ).toBeGreaterThanOrEqual(48);
      expect(
        Math.max(Number(s.height ?? 0), Number(s.minHeight ?? 0)),
      ).toBeGreaterThanOrEqual(48);
    }
  });
});
