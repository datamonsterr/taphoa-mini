import { listSales } from '@/lib/api';
import { PRODUCT_IDS } from '@/test/mock';
import { useCartStore } from '@/stores/cart';
import {
  fireEvent,
  renderApp,
  screen,
  testRouter,
  waitFor,
} from '@/test/router';

beforeEach(() => {
  const { add } = useCartStore.getState();
  add({ productId: PRODUCT_IDS.coca, name: 'Coca', price: 10000 });
  add({ productId: PRODUCT_IDS.coca, name: 'Coca', price: 10000 });
  add({ productId: PRODUCT_IDS.pepsi, name: 'Pepsi', price: 9000 });
});

it('cart -> qr -> cash change -> received creates the sale and returns to camera', async () => {
  await renderApp('/');
  expect(screen).toHavePathname('/');

  await testRouter.push('/cart');
  expect(screen).toHavePathname('/cart');
  expect(screen.getByText('29.000đ')).toBeOnTheScreen();

  await fireEvent.press(screen.getAllByLabelText('Thêm một')[0]);
  expect(screen.getByText('39.000đ')).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('Bớt một'));
  expect(screen.getByText('29.000đ')).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('Xóa'));
  expect(screen.queryByText('Pepsi')).not.toBeOnTheScreen();
  expect(screen.getByText('20.000đ')).toBeOnTheScreen();

  await fireEvent.press(screen.getByLabelText('Hiện mã QR thanh toán'));
  expect(screen).toHavePathname('/pay');
  expect(await screen.findByLabelText('Mã VietQR 20.000đ')).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('radio', { name: 'Tiền mặt' }));
  await fireEvent.press(screen.getByText('50.000'));
  expect(screen.getByLabelText('Tiền thối')).toHaveTextContent('30.000đ');

  await fireEvent.press(screen.getByRole('button', { name: 'Đã nhận tiền' }));
  await waitFor(() => expect(screen).toHavePathname('/'), { timeout: 4000 });

  expect(useCartStore.getState().lines).toEqual([]);
  const { items } = await listSales({ limit: 200 });
  const sale = items.find(
    (s) => s.cash_received === 50000 && s.total === 20000,
  );
  expect(sale).toMatchObject({ payment_method: 'cash', status: 'completed' });
});
