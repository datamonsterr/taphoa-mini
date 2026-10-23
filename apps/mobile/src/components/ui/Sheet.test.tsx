import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  fireGestureHandler,
  getByGestureTestId,
} from 'react-native-gesture-handler/jest-utils';
import { fireEvent, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Dimensions, Text } from 'react-native';

import { renderWithProviders as render, type TestMetrics } from '@/test/render';
import { colors, radius, space } from '@/theme';

import { Sheet, SHEET_PAN_TEST_ID, shouldDismiss } from './Sheet';

const renderWithProviders = (ui: ReactElement, metrics?: TestMetrics) =>
  render(
    <GestureHandlerRootView style={{ flex: 1 }}>{ui}</GestureHandlerRootView>,
    undefined,
    metrics,
  );

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

test('shouldDismiss by distance or velocity', () => {
  expect(shouldDismiss(130, 0)).toBe(true);
  expect(shouldDismiss(10, 900)).toBe(true);
  expect(shouldDismiss(50, 100)).toBe(false);
});

test('renders children, scrim token and sheet radius', async () => {
  await renderWithProviders(
    <Sheet onClose={jest.fn()} testID="sheet">
      <Text>Nội dung</Text>
    </Sheet>,
  );
  expect(screen.getByText('Nội dung')).toBeOnTheScreen();
  expect(flat(screen.getByTestId('sheet-scrim'))).toMatchObject({
    backgroundColor: colors.scrim,
  });
});

test('scrim tap closes', async () => {
  const onClose = jest.fn();
  await renderWithProviders(
    <Sheet onClose={onClose}>
      <Text>x</Text>
    </Sheet>,
  );
  await fireEvent.press(screen.getByTestId('sheet-scrim'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('scrim is not an accessibility element (no duplicate "Đóng")', async () => {
  await renderWithProviders(
    <Sheet onClose={jest.fn()}>
      <Text>x</Text>
    </Sheet>,
  );
  expect(screen.queryByRole('button', { name: 'Đóng' })).toBeNull();
});

describe('small screens', () => {
  const small: TestMetrics = {
    frame: { x: 0, y: 0, width: 320, height: 568 },
    insets: { top: 20, left: 0, right: 0, bottom: 34 },
  };
  beforeEach(() => {
    jest.spyOn(Dimensions, 'get').mockReturnValue({
      width: 320,
      height: 568,
      scale: 2,
      fontScale: 1,
    });
  });
  afterEach(() => jest.restoreAllMocks());

  test('clamps height to window minus top inset and 8', async () => {
    await renderWithProviders(
      <Sheet onClose={jest.fn()} height={748}>
        <Text>x</Text>
      </Sheet>,
      small,
    );
    expect(flat(screen.getByTestId('sheet-panel') as never).height).toBe(
      568 - 20 - 8,
    );
  });

  test('keeps requested height when it fits', async () => {
    await renderWithProviders(
      <Sheet onClose={jest.fn()} height={300}>
        <Text>x</Text>
      </Sheet>,
      small,
    );
    expect(flat(screen.getByTestId('sheet-panel') as never).height).toBe(300);
  });

  test('adds bottom inset to bottom padding and scrolls content', async () => {
    await renderWithProviders(
      <Sheet onClose={jest.fn()} height={748}>
        <Text>x</Text>
      </Sheet>,
      small,
    );
    expect(flat(screen.getByTestId('sheet-panel') as never).paddingBottom).toBe(
      space[6] + 34,
    );
    expect(screen.getByTestId('sheet-scroll')).toBeOnTheScreen();
  });

  test('non-scrollable sheet renders children directly', async () => {
    await renderWithProviders(
      <Sheet onClose={jest.fn()} scrollable={false}>
        <Text>x</Text>
      </Sheet>,
      small,
    );
    expect(screen.queryByTestId('sheet-scroll')).toBeNull();
  });
});

test('has top radius-xl and a fixed height when asked', async () => {
  await renderWithProviders(
    <Sheet onClose={jest.fn()} height={600}>
      <Text>Nội dung</Text>
    </Sheet>,
  );
  const sheet = screen.getByTestId('sheet-panel');
  const style = flat(sheet as never);
  expect(style).toMatchObject({
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    height: 600,
    shadowOpacity: 0.16,
  });
});

test('pan down past the threshold closes', async () => {
  const onClose = jest.fn();
  await renderWithProviders(
    <Sheet onClose={onClose}>
      <Text>x</Text>
    </Sheet>,
  );
  fireGestureHandler(getByGestureTestId(SHEET_PAN_TEST_ID), [
    { translationY: 20 },
    { translationY: 200, velocityY: 100 },
  ]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('short pan springs back without closing', async () => {
  const onClose = jest.fn();
  await renderWithProviders(
    <Sheet onClose={onClose}>
      <Text>x</Text>
    </Sheet>,
  );
  fireGestureHandler(getByGestureTestId(SHEET_PAN_TEST_ID), [
    { translationY: 20 },
    { translationY: 30, velocityY: 50 },
  ]);
  expect(onClose).not.toHaveBeenCalled();
});
