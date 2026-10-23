import { fireEvent, screen } from '@testing-library/react-native';
import {
  fireGestureHandler,
  getByGestureTestId,
} from 'react-native-gesture-handler/jest-utils';

import { renderWithProviders } from '@/test/render';

import { SwipeHandle } from './SwipeHandle';

describe('SwipeHandle', () => {
  it('is a labelled button', async () => {
    await renderWithProviders(<SwipeHandle onOpen={jest.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Vuốt lên: cửa hàng' }),
    ).toBeOnTheScreen();
  });

  it('opens on tap', async () => {
    const onOpen = jest.fn();
    await renderWithProviders(<SwipeHandle onOpen={onOpen} />);
    fireGestureHandler(getByGestureTestId('swipe-handle-tap'), [{ state: 5 }]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens on a pan up past the threshold', async () => {
    const onOpen = jest.fn();
    await renderWithProviders(<SwipeHandle onOpen={onOpen} />);
    fireGestureHandler(getByGestureTestId('swipe-handle-pan'), [
      { state: 2 },
      { translationY: -80, velocityY: -200, state: 4 },
      { translationY: -80, velocityY: -200, state: 5 },
    ]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens on a fast flick up', async () => {
    const onOpen = jest.fn();
    await renderWithProviders(<SwipeHandle onOpen={onOpen} />);
    fireGestureHandler(getByGestureTestId('swipe-handle-pan'), [
      { state: 2 },
      { translationY: -10, velocityY: -1200, state: 4 },
      { translationY: -10, velocityY: -1200, state: 5 },
    ]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('ignores a short or downward pan', async () => {
    const onOpen = jest.fn();
    await renderWithProviders(<SwipeHandle onOpen={onOpen} />);
    fireGestureHandler(getByGestureTestId('swipe-handle-pan'), [
      { state: 2 },
      { translationY: 30, velocityY: 100, state: 4 },
      { translationY: 30, velocityY: 100, state: 5 },
    ]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('opens from the screen-reader activate gesture', async () => {
    const onOpen = jest.fn();
    await renderWithProviders(<SwipeHandle onOpen={onOpen} />);
    await fireEvent(screen.getByRole('button'), 'accessibilityTap');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
