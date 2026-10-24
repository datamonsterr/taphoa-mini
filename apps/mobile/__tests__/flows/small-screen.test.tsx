/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories require lazily */
import { fireEvent, screen, within } from '@testing-library/react-native';
import { Dimensions } from 'react-native';

import { EditPriceSheet } from '@/features/product/EditPriceSheet';
import { CloseScreen } from '@/features/close/CloseScreen';
import { EnrollScreen } from '@/features/enroll/EnrollScreen';
import { ExpenseScreen } from '@/features/expense/ExpenseScreen';
import { resetApiClient } from '@/lib/api';
import { resetMockDb } from '@/test/mock';
import { renderWithProviders, type TestMetrics } from '@/test/render';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    CameraView: React.forwardRef(function CameraView(props: object) {
      return React.createElement(View, props);
    }),
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
  };
});

const WINDOW = { width: 320, height: 640 };
const INSET_TOP = 24;
const small: TestMetrics = {
  frame: { x: 0, y: 0, ...WINDOW },
  insets: { top: INSET_TOP, left: 0, right: 0, bottom: 0 },
};

const flat = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...[node.props.style].flat(5).filter(Boolean));

beforeEach(() => {
  resetMockDb();
  resetApiClient();
  jest.spyOn(Dimensions, 'get').mockReturnValue({
    ...WINDOW,
    scale: 2,
    fontScale: 1,
  });
});
afterEach(() => jest.restoreAllMocks());

/** The sheet fits the window and the save action is pinned outside the scroll area. */
function expectSavePinned(name: string) {
  const panel = flat(screen.getByTestId('sheet-panel') as never);
  expect(panel.height ?? panel.maxHeight).toBeLessThanOrEqual(
    WINDOW.height - INSET_TOP,
  );
  const save = within(screen.getByTestId('sheet-footer')).getByRole('button', {
    name,
  });
  expect(save).toBeOnTheScreen();
  expect(
    within(screen.getByTestId('sheet-scroll')).queryByRole('button', { name }),
  ).toBeNull();
}

function expectKeysShrunk() {
  const key = flat(screen.getByRole('button', { name: '5' }) as never);
  expect(key.width).toBe(48);
  expect(key.height).toBe(48);
}

test('Expense: keys shrink to 48 and save stays pinned at 320x640', async () => {
  await renderWithProviders(<ExpenseScreen />, undefined, small);
  expectSavePinned('Lưu khoản chi');
  expectKeysShrunk();
});

test('Close: keys shrink and save stays pinned at 320x640', async () => {
  await renderWithProviders(<CloseScreen />, undefined, small);
  const save = await screen.findByRole('button', { name: 'Chốt sổ hôm nay' });
  expect(save).toBeOnTheScreen();
  expectSavePinned('Chốt sổ hôm nay');
  expectKeysShrunk();
});

test('Enroll: keys shrink and save stays pinned at 320x640', async () => {
  await renderWithProviders(<EnrollScreen />, undefined, small);
  expectSavePinned('Lưu vào kho và thêm vào giỏ');
  expectKeysShrunk();
});

test('Edit price: keys shrink and save stays pinned at 320x640', async () => {
  await renderWithProviders(
    <EditPriceSheet price={12000} onSave={jest.fn()} onClose={jest.fn()} />,
    undefined,
    small,
  );
  expectSavePinned('Lưu giá');
  expectKeysShrunk();
});

test('keys keep their board size on a tall window', async () => {
  jest.spyOn(Dimensions, 'get').mockReturnValue({
    width: 390,
    height: 844,
    scale: 3,
    fontScale: 1,
  });
  await renderWithProviders(<ExpenseScreen />);
  const key = flat(screen.getByRole('button', { name: '5' }) as never);
  expect(key.width).toBe(76);
});

test('save is tappable on the small window', async () => {
  const onSave = jest.fn();
  await renderWithProviders(
    <EditPriceSheet price={12000} onSave={onSave} onClose={jest.fn()} />,
    undefined,
    small,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu giá' }));
  expect(onSave).toHaveBeenCalledWith(12000);
});
