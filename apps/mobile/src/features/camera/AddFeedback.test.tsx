import { act, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { renderWithProviders } from '@/test/render';

import {
  AddFeedback,
  CartPop,
  flyVector,
  measuredFlyVector,
} from './AddFeedback';

describe('flyVector', () => {
  it('points from the + slot to the cart pill on the 390 board', () => {
    const { dx, dy } = flyVector(390);
    // + centre: 390 - 29 - 32 = 329; pill centre: 80.
    expect(dx).toBeCloseTo(80 - 329);
    expect(dy).toBe(162);
  });
});

describe('measuredFlyVector', () => {
  it('uses the measured centres of the + slot and the cart pill', () => {
    const add = { x: 280, y: 0, width: 64, height: 64 };
    const pill = { x: 16, y: 0, width: 128, height: 56 };
    // + centre (312, 590 + 32); pill centre (80, 756 + 28).
    expect(measuredFlyVector(add, 590, pill, 756)).toEqual({
      dx: 80 - 312,
      dy: 784 - 622,
    });
  });

  it('follows a different layout (taller screen)', () => {
    const add = { x: 0, y: 10, width: 40, height: 40 };
    const pill = { x: 0, y: 0, width: 40, height: 40 };
    expect(measuredFlyVector(add, 100, pill, 400)).toEqual({
      dx: 0,
      dy: 420 - 130,
    });
  });
});

describe('AddFeedback', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('draws nothing until triggered', async () => {
    await renderWithProviders(<AddFeedback trigger={0} dx={-10} dy={50} />);
    expect(screen.queryByTestId('add-fly')).toBeNull();
  });

  it('flies one dot per trigger and removes it when done', async () => {
    const { rerender } = await renderWithProviders(
      <AddFeedback trigger={0} dx={-10} dy={50} />,
    );
    await rerender(<AddFeedback trigger={1} dx={-10} dy={50} />);
    expect(screen.getByTestId('add-fly')).toBeOnTheScreen();
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(screen.queryByTestId('add-fly')).toBeNull();
    await rerender(<AddFeedback trigger={2} dx={-10} dy={50} />);
    expect(screen.getByTestId('add-fly')).toBeOnTheScreen();
  });
});

describe('CartPop', () => {
  it('renders its child and survives count changes', async () => {
    const { rerender } = await renderWithProviders(
      <CartPop count={0}>
        <Text>pill</Text>
      </CartPop>,
    );
    await rerender(
      <CartPop count={1}>
        <Text>pill</Text>
      </CartPop>,
    );
    expect(screen.getByText('pill')).toBeOnTheScreen();
  });
});
