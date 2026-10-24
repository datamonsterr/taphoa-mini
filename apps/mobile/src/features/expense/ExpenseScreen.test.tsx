import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Linking } from 'react-native';

import { resetApiClient } from '@/lib/api';
import * as images from '@/lib/api/images';
import * as ledger from '@/lib/api/ledger';
import { resetMockDb } from '@/test/mock';
import { renderWithProviders } from '@/test/render';

import { ExpenseScreen } from './ExpenseScreen';

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: jest.fn(() => true),
  },
}));

beforeEach(() => {
  resetMockDb();
  resetApiClient();
  jest.clearAllMocks();
});

afterEach(() => jest.restoreAllMocks());

const press = (name: string | RegExp) =>
  fireEvent.press(screen.getByRole('button', { name }));
const type = async (keys: string[]) => {
  for (const key of keys) await press(key);
};
const save = () => screen.getByRole('button', { name: 'Lưu khoản chi' });

test('starts empty: header, four categories, −0đ, save disabled', async () => {
  await renderWithProviders(<ExpenseScreen />);
  expect(
    screen.getByRole('header', { name: 'Thêm chi phí' }),
  ).toBeOnTheScreen();
  const group = screen.getByLabelText('Loại chi');
  expect(group).toBeOnTheScreen();
  for (const name of ['Nhập', 'Điện', 'Nước', 'Khác']) {
    expect(screen.getByRole('radio', { name })).not.toBeChecked();
  }
  expect(screen.getByLabelText('Số tiền chi')).toHaveTextContent('−0đ');
  expect(save()).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Chụp hóa đơn' }),
  ).toBeOnTheScreen();
});

test('keypad builds the amount and delete removes a digit', async () => {
  await renderWithProviders(<ExpenseScreen />);
  await type(['5', '0', '000']);
  expect(screen.getByLabelText('Số tiền chi')).toHaveTextContent('−50.000đ');
  await press('Xóa');
  expect(screen.getByLabelText('Số tiền chi')).toHaveTextContent('−5.000đ');
});

test('a category is selected one at a time', async () => {
  await renderWithProviders(<ExpenseScreen />);
  await fireEvent.press(screen.getByRole('radio', { name: 'Điện' }));
  expect(screen.getByRole('radio', { name: 'Điện' })).toBeChecked();
  await fireEvent.press(screen.getByRole('radio', { name: 'Nước' }));
  expect(screen.getByRole('radio', { name: 'Điện' })).not.toBeChecked();
  expect(screen.getByRole('radio', { name: 'Nước' })).toBeChecked();
});

test('save needs both an amount and a category', async () => {
  await renderWithProviders(<ExpenseScreen />);
  await type(['5']);
  expect(save()).toBeDisabled();
  await fireEvent.press(screen.getByRole('radio', { name: 'Nhập' }));
  expect(save()).toBeEnabled();
  await type(['Xóa']);
  expect(save()).toBeDisabled();
});

test('save stores the expense, buzzes and dismisses', async () => {
  await renderWithProviders(<ExpenseScreen />);
  await type(['5', '0', '000']);
  await fireEvent.press(screen.getByRole('radio', { name: 'Điện' }));
  await fireEvent.press(save());
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
  const { items } = await ledger.listExpenses();
  expect(items[0]).toMatchObject({
    amount: 50000,
    category: 'dien',
    paid_with: 'cash_box',
  });
  expect(items[0]!.image).toBeNull();
});

test('the close circle dismisses without saving', async () => {
  await renderWithProviders(<ExpenseScreen />);
  const before = (await ledger.listExpenses()).items.length;
  await fireEvent.press(screen.getByTestId('expense-close'));
  expect(router.back).toHaveBeenCalled();
  expect((await ledger.listExpenses()).items).toHaveLength(before);
});

test('a failed save keeps the sheet open and says so', async () => {
  jest.spyOn(ledger, 'createExpense').mockRejectedValueOnce(new Error('x'));
  await renderWithProviders(<ExpenseScreen />);
  await type(['5', '000']);
  await fireEvent.press(screen.getByRole('radio', { name: 'Khác' }));
  await fireEvent.press(save());
  expect(
    await screen.findByText('Không lưu được khoản chi. Thử lại.'),
  ).toBeOnTheScreen();
  expect(router.back).not.toHaveBeenCalled();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  // retry succeeds
  await fireEvent.press(save());
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(screen.queryByText('Không lưu được khoản chi. Thử lại.')).toBeNull();
});

test('a retry after a failed save reuses the same expense id', async () => {
  const create = jest
    .spyOn(ledger, 'createExpense')
    .mockRejectedValueOnce(new Error('x'));
  await renderWithProviders(<ExpenseScreen />);
  await type(['5', '000']);
  await fireEvent.press(screen.getByRole('radio', { name: 'Khác' }));
  const before = (await ledger.listExpenses()).items.length;
  await fireEvent.press(save());
  await screen.findByText('Không lưu được khoản chi. Thử lại.');
  await fireEvent.press(save());
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]![0].id).toBe(create.mock.calls[0]![0].id);
  expect((await ledger.listExpenses()).items).toHaveLength(before + 1);
});

describe('bill photo', () => {
  const shootAndUse = async () => {
    await press('Chụp hóa đơn');
    await press('Chụp');
    await press('Dùng ảnh');
  };

  test('capture, preview and use shows a thumbnail', async () => {
    await renderWithProviders(<ExpenseScreen />);
    await press('Chụp hóa đơn');
    expect(screen.getByTestId('bill-camera')).toBeOnTheScreen();
    await press('Chụp');
    expect(await screen.findByTestId('viewfinder-photo')).toBeOnTheScreen();
    await press('Dùng ảnh');
    expect(screen.queryByTestId('bill-camera')).toBeNull();
    expect(screen.getByTestId('bill-thumb')).toBeOnTheScreen();
  });

  test('retake returns to the live camera; closing keeps no photo', async () => {
    await renderWithProviders(<ExpenseScreen />);
    await press('Chụp hóa đơn');
    await press('Chụp');
    await press('Chụp lại');
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
    await press('Đóng camera');
    expect(screen.queryByTestId('bill-camera')).toBeNull();
    expect(screen.queryByTestId('bill-thumb')).toBeNull();
  });

  test('the thumbnail reopens the camera', async () => {
    await renderWithProviders(<ExpenseScreen />);
    await shootAndUse();
    await press('Ảnh hóa đơn');
    expect(screen.getByTestId('bill-camera')).toBeOnTheScreen();
  });

  test('save uploads the photo as an expense receipt first', async () => {
    // Node's FormData cannot carry React Native's { uri } file part; the mock reads a Blob.
    const real = images.uploadImage;
    const upload = jest
      .spyOn(images, 'uploadImage')
      .mockImplementation((_file, purpose) =>
        real(new Blob(['x'], { type: 'image/jpeg' }), purpose),
      );
    await renderWithProviders(<ExpenseScreen />);
    await shootAndUse();
    await type(['2', '000']);
    await fireEvent.press(screen.getByRole('radio', { name: 'Nước' }));
    await fireEvent.press(save());
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'file:///mock.jpg' }),
      'expense_receipt',
    );
    const { items } = await ledger.listExpenses();
    expect(items[0]!.image_id).toEqual(expect.any(String));
  });

  test('without camera permission it asks for it', async () => {
    const request = jest.fn().mockResolvedValue({ granted: true });
    jest
      .spyOn(jest.requireMock('expo-camera'), 'useCameraPermissions')
      .mockReturnValue([
        { granted: false, status: 'denied', canAskAgain: true } as never,
        request,
        jest.fn(),
      ]);
    await renderWithProviders(<ExpenseScreen />);
    await press('Chụp hóa đơn');
    expect(screen.queryByTestId('camera-view')).toBeNull();
    await press('Cho phép camera');
    expect(request).toHaveBeenCalled();
  });

  test('when the system will not ask again it opens the settings instead', async () => {
    const request = jest.fn();
    jest
      .spyOn(jest.requireMock('expo-camera'), 'useCameraPermissions')
      .mockReturnValue([
        { granted: false, status: 'denied', canAskAgain: false } as never,
        request,
        jest.fn(),
      ]);
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    await renderWithProviders(<ExpenseScreen />);
    await press('Chụp hóa đơn');
    expect(
      screen.queryByRole('button', { name: 'Cho phép camera' }),
    ).toBeNull();
    await press('Mở cài đặt');
    expect(open).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
});
