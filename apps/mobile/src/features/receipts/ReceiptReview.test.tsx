import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { onlineManager } from '@tanstack/react-query';
import { Alert, Platform } from 'react-native';
import { ApiError } from '@/lib/api/errors';
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
afterEach(() => {
  onlineManager.setOnline(true);
  jest.restoreAllMocks();
});
const button = (name: string) => screen.getByRole('button', { name });
const open = async () => {
  await renderWithProviders(<ReceiptReviewScreen id={receipt.id} />);
  await screen.findByText('Bánh Chocopie hộp');
};
const dropUnmatched = () =>
  fireEvent.press(button('Xóa dòng Bánh Chocopie hộp'));
const reviewSummary = () => fireEvent.press(button('Xong, xem lại'));
const setPrice = async (name: string, digits: string) => {
  const pill = screen.getByRole('button', {
    name: new RegExp(`^Giá nhập: ${name},`),
  });
  const current = String(pill.props.accessibilityLabel)
    .match(/, ([\d.]+)đ,/)![1]
    .replace(/\./g, '');
  await fireEvent.press(pill);
  for (let i = 0; i < current.length; i++) await fireEvent.press(button('Xóa'));
  for (const digit of digits) await fireEvent.press(button(digit));
  await fireEvent.press(button('Xong'));
};

test('renders OCR source, status, fix count and photo; summary blocks unmatched confirm and names the line', async () => {
  await open();
  expect(screen.getAllByText('Coca-Cola lon 330ml').length).toBeGreaterThan(0);
  expect(button('Bánh Chocopie hộp, chạm để đổi sản phẩm')).toBeOnTheScreen();
  expect(screen.getByText('4 dòng đọc được · 1 cần xem')).toBeOnTheScreen();
  expect(
    screen.getByText(`Đọc được: “${receipt.lines[0].raw_text}”`),
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Xác nhận nhập kho' }),
  ).toBeNull();
  expect(screen.getByLabelText('Tổng tiền')).toHaveTextContent('456.000đ');
  expect(screen.queryByText('inception/mercury-decide:free')).toBeNull();
  await fireEvent.press(button('Ảnh hóa đơn'));
  expect(screen.getByTestId('receipt-full-photo')).toBeOnTheScreen();
  await fireEvent.press(button('Đóng ảnh'));
  await reviewSummary();
  expect(button('Xác nhận nhập kho')).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Chọn sản phẩm cho: Bánh Chocopie hộp',
  );
});

test('candidate probabilities appear first and picking enables confirmation', async () => {
  await open();
  await fireEvent.press(button('Bánh Chocopie hộp, chạm để đổi sản phẩm'));
  const candidate = receipt.lines[3].candidates[0];
  await fireEvent.press(
    await screen.findByRole('button', { name: `${candidate.name} 45%` }),
  );
  await reviewSummary();
  expect(button('Xác nhận nhập kho')).toBeEnabled();
});

test('catalog search maps an unmatched line', async () => {
  await open();
  await fireEvent.press(button('Bánh Chocopie hộp, chạm để đổi sản phẩm'));
  await fireEvent.changeText(screen.getByLabelText('Tìm sản phẩm'), 'Pepsi');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Pepsi lon 330ml' }),
  );
  await reviewSummary();
  expect(button('Xác nhận nhập kho')).toBeEnabled();
});

test('edits quantity and line cost, updates total, drops a line and confirms the exact retained payload', async () => {
  const confirm = jest.spyOn(receipts, 'confirmReceipt');
  await open();
  await fireEvent.press(button('Thêm một: Coca-Cola lon 330ml'));
  await setPrice('Coca-Cola lon 330ml', '8400');
  expect(screen.getByLabelText('Tổng tiền')).toHaveTextContent('462.000đ');
  await dropUnmatched();
  expect(screen.queryByText('Bánh Chocopie hộp')).toBeNull();
  expect(screen.getByLabelText('Tổng tiền')).toHaveTextContent('396.000đ');
  await reviewSummary();
  await fireEvent.press(screen.getByRole('radio', { name: 'Chuyển khoản' }));
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

test('minimum quantity stays one and unknown price contributes one fix per line', async () => {
  await open();
  await dropUnmatched();
  await setPrice('Coca-Cola lon 330ml', '0');
  expect(screen.getByText('Giá chưa rõ')).toBeOnTheScreen();
  expect(screen.getByText('3 dòng đọc được · 1 cần xem')).toBeOnTheScreen();
  expect(screen.getByLabelText('Tổng tiền')).toHaveTextContent('186.000đ');
  await setPrice('Coca-Cola lon 330ml', '8500');
  expect(screen.getByText('3 dòng đọc được · 0 cần xem')).toBeOnTheScreen();
});

test('adds a blank line, maps it, edits its price and quantity and omits line_id in the payload', async () => {
  const confirm = jest.spyOn(receipts, 'confirmReceipt');
  await open();
  await dropUnmatched();
  await fireEvent.press(button('Thêm dòng'));
  expect(screen.getByText('4 dòng đọc được · 1 cần xem')).toBeOnTheScreen();
  expect(screen.getByText('Chọn sản phẩm')).toBeOnTheScreen();
  expect(screen.getByLabelText('Số lượng: Dòng mới 1')).toHaveTextContent('1');
  expect(button('Bớt một: Dòng mới 1')).toBeDisabled();
  await fireEvent.press(button('Dòng mới 1, chạm để đổi sản phẩm'));
  await fireEvent.changeText(screen.getByLabelText('Tìm sản phẩm'), 'Pepsi');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Pepsi lon 330ml' }),
  );
  expect(screen.getByText('Giá chưa rõ')).toBeOnTheScreen();
  await setPrice('Dòng mới 1', '5000');
  await fireEvent.press(button('Thêm một: Dòng mới 1'));
  expect(screen.getByLabelText('Thành tiền: Dòng mới 1')).toHaveTextContent(
    '10.000đ',
  );
  expect(screen.getByText('Tổng tiền · 68 món')).toBeOnTheScreen();
  expect(screen.getByLabelText('Tổng tiền')).toHaveTextContent('400.000đ');
  expect(screen.getByText('4 dòng đọc được · 0 cần xem')).toBeOnTheScreen();
  await reviewSummary();
  await fireEvent.press(button('Xác nhận nhập kho'));
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/'));
  const newLine = confirm.mock.calls[0][1].lines[3];
  expect(newLine).toEqual({
    product_id: expect.any(String),
    quantity: 2,
    cost: 10000,
  });
  expect(newLine).not.toHaveProperty('line_id');
});

test('deleting the line whose keypad is open closes it; deleting every line blocks next step', async () => {
  await open();
  await fireEvent.press(button('Thêm dòng'));
  await fireEvent.press(
    screen.getByRole('button', { name: /^Giá nhập: Dòng mới 1,/ }),
  );
  await fireEvent.press(button('Xóa dòng Dòng mới 1'));
  expect(screen.queryByRole('button', { name: 'Xong' })).toBeNull();
  expect(screen.getByText('4 dòng đọc được · 1 cần xem')).toBeOnTheScreen();
  for (const line of receipt.lines)
    await fireEvent.press(button(`Xóa dòng ${line.product_name}`));
  expect(screen.getByLabelText('Tổng tiền')).toHaveTextContent('0đ');
  expect(button('Xong, xem lại')).toBeDisabled();
});

test('summary and back preserve edits without confirming', async () => {
  const confirm = jest.spyOn(receipts, 'confirmReceipt');
  await open();
  await fireEvent.press(button('Thêm một: Coca-Cola lon 330ml'));
  await reviewSummary();
  expect(screen.getByRole('header')).toHaveTextContent('Hóa đơn nhập');
  expect(screen.queryByRole('button', { name: 'Thêm dòng' })).toBeNull();
  expect(screen.getByText('25 × 8.500đ')).toBeOnTheScreen();
  await fireEvent.press(button('Quay lại'));
  expect(screen.getByRole('header')).toHaveTextContent('Kiểm tra hóa đơn');
  expect(
    screen.getByLabelText('Số lượng: Coca-Cola lon 330ml'),
  ).toHaveTextContent('25');
  expect(confirm).not.toHaveBeenCalled();
});

test.each([
  [3, 100],
  [4, 133],
])(
  'quantity %i preserves fractional unit-price precision in line cost %i',
  async (quantity, cost) => {
    const confirm = jest.spyOn(receipts, 'confirmReceipt');
    Object.assign(getMockDb().receipts[0].lines[0], { quantity: 3, cost: 100 });
    await open();
    await dropUnmatched();
    await fireEvent.press(
      screen.getByRole('button', { name: /^Giá nhập: Coca-Cola lon 330ml,/ }),
    );
    await fireEvent.press(button('Xong'));
    if (quantity === 4)
      await fireEvent.press(button('Thêm một: Coca-Cola lon 330ml'));
    expect(
      screen.getByLabelText('Thành tiền: Coca-Cola lon 330ml'),
    ).toHaveTextContent(`${cost}đ`);
    await reviewSummary();
    await fireEvent.press(button('Xác nhận nhập kho'));
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/'));
    expect(confirm.mock.calls[0][1].lines[0]).toMatchObject({ quantity, cost });
  },
);

test('zero unit price warns but remains a valid stock import', async () => {
  const confirm = jest.spyOn(receipts, 'confirmReceipt');
  await open();
  await dropUnmatched();
  await setPrice('Coca-Cola lon 330ml', '0');
  await reviewSummary();
  expect(button('Xác nhận nhập kho')).toBeEnabled();
  await fireEvent.press(button('Xác nhận nhập kho'));
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/'));
  expect(confirm.mock.calls[0][1].lines[0].cost).toBe(0);
});

test('adding lines respects the confirmation API limit of 100', async () => {
  const original = getMockDb().receipts[0].lines[0];
  getMockDb().receipts[0].lines = Array.from({ length: 100 }, (_, index) => ({
    ...original,
    id: `line-${index}`,
    product_name: `Sản phẩm ${index + 1}`,
  }));
  await renderWithProviders(<ReceiptReviewScreen id={receipt.id} />);
  expect(
    await screen.findByRole('button', { name: 'Thêm dòng' }),
  ).toBeDisabled();
  await fireEvent.press(button('Xóa dòng Sản phẩm 100'));
  expect(button('Thêm dòng')).toBeEnabled();
  await fireEvent.press(button('Thêm dòng'));
  expect(button('Thêm dòng')).toBeDisabled();
  expect(screen.getByText('100 dòng đọc được · 1 cần xem')).toBeOnTheScreen();
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
  await reviewSummary();
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
    .mockRejectedValueOnce(new ApiError(500, { error: 'down' }));
  await open();
  await dropUnmatched();
  await reviewSummary();
  await fireEvent.press(button('Xác nhận nhập kho'));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Chưa lưu được hóa đơn. Thử lại.',
  );
  expect(button('Xác nhận nhập kho')).toBeEnabled();
});

const OFFLINE =
  'Không có mạng nên chưa nhập kho được. Bản nháp vẫn còn, thử lại khi có mạng.';

test('confirming offline says so at once, keeps the draft and confirms after reconnecting (#243)', async () => {
  const confirm = jest.spyOn(receipts, 'confirmReceipt');
  await open();
  await dropUnmatched();
  await reviewSummary();
  await act(async () => onlineManager.setOnline(false));
  await fireEvent.press(button('Xác nhận nhập kho'));
  expect(await screen.findByRole('alert')).toHaveTextContent(OFFLINE);
  expect(confirm).not.toHaveBeenCalled();
  expect(button('Xác nhận nhập kho')).toBeEnabled();
  expect(screen.queryByText('Chưa lưu được hóa đơn. Thử lại.')).toBeNull();
  await act(async () => onlineManager.setOnline(true));
  await fireEvent.press(button('Xác nhận nhập kho'));
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/'));
  expect(confirm).toHaveBeenCalledTimes(1);
});

test('a connection that drops during the confirm request gets the offline message, not a spinner', async () => {
  jest.spyOn(receipts, 'confirmReceipt').mockImplementationOnce(async () => {
    onlineManager.setOnline(false);
    throw new TypeError('Network request failed');
  });
  await open();
  await dropUnmatched();
  await reviewSummary();
  await fireEvent.press(button('Xác nhận nhập kho'));
  expect(await screen.findByRole('alert')).toHaveTextContent(OFFLINE);
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
  await reviewSummary();
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
    await reviewSummary();
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
