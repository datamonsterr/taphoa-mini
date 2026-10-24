import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { createReceipt, uploadImage } from '@/lib/api';
import * as receipts from '@/lib/api/receipts';
import { renderWithProviders } from '@/test/render';
import { ReceiptHistoryScreen } from './ReceiptHistoryScreen';

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
    replace: jest.fn(),
  },
}));
afterEach(() => jest.restoreAllMocks());
test('empty history', async () => {
  await renderWithProviders(<ReceiptHistoryScreen />);
  expect(await screen.findByText('Chưa có hóa đơn nhập')).toBeOnTheScreen();
});
test('newest first with date, total, match count, status, photo and navigation', async () => {
  const image = await uploadImage(
    new Blob(['receipt'], { type: 'image/jpeg' }),
    'expense_receipt',
  );
  const old = await createReceipt({ image_id: image.id });
  const recent = await createReceipt({ image_id: image.id });
  await renderWithProviders(<ReceiptHistoryScreen />);
  await screen.findAllByText('3/4');
  expect(
    screen
      .getAllByTestId('receipt-history-row')
      .map((r) => r.props.accessibilityLabel),
  ).toEqual([
    expect.stringContaining(recent.id),
    expect.stringContaining(old.id),
  ]);
  expect(screen.getAllByText('456.000đ')).toHaveLength(2);
  expect(screen.getAllByText('Bản nháp')).toHaveLength(2);
  expect(screen.getAllByTestId('receipt-history-photo')).toHaveLength(2);
  await fireEvent.press(screen.getAllByTestId('receipt-history-row')[0]);
  expect(router.push).toHaveBeenCalledWith(`/receipt/${recent.id}`);
});
test('infinite scrolling follows the next cursor', async () => {
  const list = jest
    .spyOn(receipts, 'listReceipts')
    .mockResolvedValueOnce({ items: [], next_cursor: 'next-page' })
    .mockResolvedValueOnce({ items: [], next_cursor: null });
  await renderWithProviders(<ReceiptHistoryScreen />);
  await screen.findByText('Chưa có hóa đơn nhập');
  expect(list).toHaveBeenCalledTimes(1);
  await fireEvent(screen.getByTestId('receipt-history-list'), 'onEndReached');
  await waitFor(() =>
    expect(list).toHaveBeenCalledWith({
      status: undefined,
      cursor: 'next-page',
    }),
  );
});
test('error offers retry', async () => {
  jest
    .spyOn(receipts, 'listReceipts')
    .mockRejectedValueOnce(new Error('offline'));
  await renderWithProviders(<ReceiptHistoryScreen />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Thử lại' }));
  expect(await screen.findByText('Chưa có hóa đơn nhập')).toBeOnTheScreen();
});
