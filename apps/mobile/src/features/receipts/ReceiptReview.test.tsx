import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert, Platform } from 'react-native';
import { createReceipt, uploadImage, type Receipt } from '@/lib/api';
import * as receipts from '@/lib/api/receipts';
import { getMockDb } from '@/test/mock';
import { renderWithProviders } from '@/test/render';
import { ReceiptReviewScreen } from './ReceiptReviewScreen';
import { ReceiptToast, useReceiptNotice } from './ReceiptToast';

jest.mock('expo-router', () => ({
  router: { dismissTo: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ id: 'unused' }),
}));
let receipt: Receipt;
beforeEach(async () => {
  jest.clearAllMocks();
  useReceiptNotice.setState({ count: null });
  const image = await uploadImage(
    new Blob(['receipt'], { type: 'image/jpeg' }),
    'expense_receipt',
  );
  receipt = await createReceipt({ image_id: image.id });
});
afterEach(() => jest.restoreAllMocks());
const button = (name: string) => screen.getByRole('button', { name });
const open = async () => {
  await renderWithProviders(<ReceiptReviewScreen id={receipt.id} />);
  await screen.findByText('Bánh Chocopie hộp');
};
const dropUnmatched = () =>
  fireEvent.press(button('Bỏ dòng Bánh Chocopie hộp'));

test('renders receipt names, mapped catalog names, date and photo; hides parser and blocks unmatched confirm', async () => {
  await open();
  expect(screen.getAllByText('Coca-Cola lon 330ml').length).toBeGreaterThan(0);
  expect(button('Chưa khớp: Bánh Chocopie hộp')).toBeOnTheScreen();
  expect(button('Xác nhận nhập kho')).toBeDisabled();
  expect(screen.getByLabelText('Tổng tiền')).toHaveTextContent('456.000đ');
  expect(screen.queryByText('inception/mercury-decide:free')).toBeNull();
  await fireEvent.press(button('Ảnh hóa đơn'));
  expect(screen.getByTestId('receipt-full-photo')).toBeOnTheScreen();
  await fireEvent.press(button('Đóng ảnh'));
});

test('candidate probabilities appear first and picking enables confirmation', async () => {
  await open();
  await fireEvent.press(button('Chưa khớp: Bánh Chocopie hộp'));
  const candidate = receipt.lines[3].candidates[0];
  await fireEvent.press(
    await screen.findByRole('button', { name: `${candidate.name} 45%` }),
  );
  expect(button('Xác nhận nhập kho')).toBeEnabled();
});

test('catalog search maps an unmatched line', async () => {
  await open();
  await fireEvent.press(button('Chưa khớp: Bánh Chocopie hộp'));
  await fireEvent.changeText(screen.getByLabelText('Tìm sản phẩm'), 'Pepsi');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Pepsi lon 330ml' }),
  );
  expect(button('Xác nhận nhập kho')).toBeEnabled();
});

test('edits quantity and line cost, updates total, drops a line and confirms the exact retained payload', async () => {
  const confirm = jest.spyOn(receipts, 'confirmReceipt');
  await open();
  await fireEvent.changeText(
    screen.getByLabelText('Số lượng: Coca-Cola lon 330ml'),
    '25',
  );
  await fireEvent.changeText(
    screen.getByLabelText('Thành tiền: Coca-Cola lon 330ml'),
    '210000',
  );
  expect(screen.getByLabelText('Tổng tiền')).toHaveTextContent('462.000đ');
  await dropUnmatched();
  expect(screen.queryByText('Bánh Chocopie hộp')).toBeNull();
  expect(screen.getByLabelText('Tổng tiền')).toHaveTextContent('396.000đ');
  await fireEvent.press(screen.getByRole('radio', { name: 'Khác' }));
  await fireEvent.press(button('Xác nhận nhập kho'));
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/'));
  expect(confirm.mock.calls[0][1]).toEqual({
    lines: receipt.lines.slice(0, 3).map((l, i) => ({
      line_id: l.id,
      product_id: l.product_id,
      quantity: i === 0 ? 25 : l.quantity,
      cost: i === 0 ? 210000 : l.cost,
    })),
    paid_with: 'other',
  });
  expect(getMockDb().receipts[0].status).toBe('confirmed');
  await renderWithProviders(<ReceiptToast />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Đã nhập kho 3 sản phẩm',
  );
});

test('empty, zero and invalid values cannot confirm', async () => {
  await open();
  await dropUnmatched();
  await fireEvent.changeText(
    screen.getByLabelText('Số lượng: Coca-Cola lon 330ml'),
    '0',
  );
  expect(button('Xác nhận nhập kho')).toBeDisabled();
  await fireEvent.changeText(
    screen.getByLabelText('Số lượng: Coca-Cola lon 330ml'),
    '1',
  );
  await fireEvent.changeText(
    screen.getByLabelText('Thành tiền: Coca-Cola lon 330ml'),
    '',
  );
  expect(button('Xác nhận nhập kho')).toBeDisabled();
});

test('confirmed receipts are read-only and show the linked expense amount', async () => {
  await receipts.confirmReceipt(receipt.id, {
    paid_with: 'cash_box',
    lines: receipt.lines.slice(0, 3).map((l) => ({
      line_id: l.id,
      product_id: l.product_id!,
      quantity: l.quantity,
      cost: l.cost,
    })),
  });
  await renderWithProviders(<ReceiptReviewScreen id={receipt.id} />);
  expect(await screen.findByLabelText('Khoản chi liên kết')).toHaveTextContent(
    'Khoản chi liên kết: 390.000đ',
  );
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Xác nhận nhập kho' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Bỏ bản nháp' })).toBeNull();
});

test('discard requires confirmation and deletes the draft', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  await open();
  await fireEvent.press(button('Bỏ bản nháp'));
  expect(getMockDb().receipts[0].status).toBe('draft');
  const accept = alert.mock.calls[0][2]!.find(
    (b) => b.style === 'destructive',
  )!;
  await act(async () => {
    await accept.onPress?.();
  });
  await waitFor(() => expect(getMockDb().receipts[0].status).toBe('discarded'));
});

test('confirmation failure keeps edits visible and allows retry', async () => {
  jest
    .spyOn(receipts, 'confirmReceipt')
    .mockRejectedValueOnce(new Error('offline'));
  await open();
  await dropUnmatched();
  await fireEvent.press(button('Xác nhận nhập kho'));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Chưa lưu được hóa đơn. Thử lại.',
  );
  expect(button('Xác nhận nhập kho')).toBeEnabled();
});

test('lost confirmation response retries once without recording stock twice', async () => {
  const original = receipts.confirmReceipt;
  const confirm = jest
    .spyOn(receipts, 'confirmReceipt')
    .mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('response lost');
    });
  await open();
  await dropUnmatched();
  await fireEvent.press(button('Xác nhận nhập kho'));
  await screen.findByRole('alert');
  const movements = [...getMockDb().stockMovements.values()].flat().length;
  await fireEvent.press(button('Xác nhận nhập kho'));
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/'));
  expect(confirm.mock.calls[0][2]).toBe(confirm.mock.calls[1][2]);
  expect([...getMockDb().stockMovements.values()].flat()).toHaveLength(
    movements,
  );
});

test('browser discard dialog can cancel or confirm', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const previous = window.confirm;
  const confirm = jest
    .fn()
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true);
  window.confirm = confirm;
  try {
    await open();
    await fireEvent.press(button('Bỏ bản nháp'));
    expect(confirm).toHaveBeenCalledWith('Bỏ hóa đơn này?');
    expect(getMockDb().receipts[0].status).toBe('draft');
    await fireEvent.press(button('Bỏ bản nháp'));
    await waitFor(() =>
      expect(getMockDb().receipts[0].status).toBe('discarded'),
    );
  } finally {
    window.confirm = previous;
  }
});
