import { createReceipt, uploadImage } from '@/lib/api';
import { fireEvent, renderApp, screen, waitFor } from '@/test/router';

afterEach(() => jest.restoreAllMocks());

test('Kho tab has a Nhập hàng button that opens /receipts', async () => {
  await renderApp('/inventory');
  await screen.findByTestId('inventory-list');
  const btn = screen.getByRole('button', { name: 'Nhập hàng' });
  expect(btn).toBeOnTheScreen();
  await fireEvent.press(btn);
  expect(
    await screen.findByRole('header', { name: 'Nhập hàng' }),
  ).toBeOnTheScreen();
  expect(screen).toHavePathname('/receipts');
});

test('on /receipts, tapping a receipt history item opens the unified review at /receipts?receiptId=<id>', async () => {
  const image = await uploadImage(
    new Blob(['receipt'], { type: 'image/jpeg' }),
    'expense_receipt',
  );
  const receipt = await createReceipt({ image_id: image.id });
  await renderApp('/receipts');
  expect(await screen.findByTestId('receipt-history-list')).toBeOnTheScreen();
  const row = (await screen.findAllByTestId('receipt-history-row'))[0];
  await fireEvent.press(row);
  expect(
    await screen.findByRole('button', { name: 'Xác nhận nhập kho' }),
  ).toBeOnTheScreen();
  expect(screen).toHavePathname('/receipts');
  expect(screen).toHaveSearchParams({ receiptId: receipt.id });
  // Verify there is NO separate "Xong, xem lại" button
  expect(screen.queryByRole('button', { name: 'Xong, xem lại' })).toBeNull();
});

test('confirming receipt navigates to Kho Tồn kho segment (/inventory?segment=stock)', async () => {
  const image = await uploadImage(
    new Blob(['receipt'], { type: 'image/jpeg' }),
    'expense_receipt',
  );
  const receipt = await createReceipt({ image_id: image.id });
  await renderApp(`/receipts?receiptId=${receipt.id}`);
  await screen.findByText('Bánh Chocopie hộp');
  await fireEvent.press(
    screen.getByRole('button', { name: 'Xóa dòng Bánh Chocopie hộp' }),
  );
  const confirmBtn = await screen.findByRole('button', {
    name: 'Xác nhận nhập kho',
  });
  await fireEvent.press(confirmBtn);
  await waitFor(() => {
    expect(screen).toHavePathname('/inventory');
    expect(screen).toHaveSearchParams({ segment: 'stock' });
  });
});

test('cold /receipt/:id replaces into /receipts?receiptId=<id>', async () => {
  const image = await uploadImage(
    new Blob(['receipt'], { type: 'image/jpeg' }),
    'expense_receipt',
  );
  const receipt = await createReceipt({ image_id: image.id });
  await renderApp(`/receipt/${receipt.id}`);
  expect(
    await screen.findByRole('button', { name: 'Xác nhận nhập kho' }),
  ).toBeOnTheScreen();
  expect(screen).toHavePathname('/receipts');
  expect(screen).toHaveSearchParams({ receiptId: receipt.id });
});

test('missing receipt ID displays error message and button to return to receipts', async () => {
  await renderApp('/receipts?receiptId=00000000-0000-0000-0000-000000000000');
  expect(
    await screen.findByText('Không tìm thấy hóa đơn này. Có thể nó đã bị xóa.'),
  ).toBeOnTheScreen();
  const backBtn = screen.getByRole('button', { name: 'Về nhập hàng' });
  await fireEvent.press(backBtn);
  expect(
    await screen.findByRole('header', { name: 'Nhập hàng' }),
  ).toBeOnTheScreen();
  expect(screen).toHavePathname('/receipts');
  expect(screen).toHaveSearchParams({});
});
