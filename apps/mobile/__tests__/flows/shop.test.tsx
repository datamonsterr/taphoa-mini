import { PRODUCT_IDS } from '@/test/mock';
import {
  fireEvent,
  renderApp,
  screen,
  testRouter,
  waitFor,
} from '@/test/router';

const COCA = (price: string) => `Coca-Cola lon 330ml, ${price}`;
const SEVEN_UP = '7Up lon 330ml, 9.000đ';

async function openShop() {
  await renderApp('/');
  await testRouter.push('/inventory');
  expect(screen).toHavePathname('/inventory');
}

test('search, open a product, edit its price, see it in detail and in the grid', async () => {
  await openShop();
  expect(
    await screen.findByRole('button', { name: SEVEN_UP }),
  ).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('button', { name: 'Tìm' }));
  await fireEvent.changeText(screen.getByLabelText('Tìm sản phẩm'), 'Coca');
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: SEVEN_UP })).toBeNull(),
  );
  expect(
    await screen.findByRole('button', { name: COCA('10.000đ') }),
  ).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('button', { name: COCA('10.000đ') }));
  expect(screen).toHavePathname(`/product/${PRODUCT_IDS.coca}`);
  expect(
    await screen.findByRole('header', { name: 'Coca-Cola lon 330ml' }),
  ).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('button', { name: 'Sửa giá' }));
  for (const key of ['Xóa', 'Xóa', 'Xóa', 'Xóa', 'Xóa', '1', '2', '000']) {
    await fireEvent.press(screen.getByRole('button', { name: key }));
  }
  await fireEvent.press(screen.getByRole('button', { name: 'Lưu giá' }));
  expect(await screen.findByText('12.000đ')).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('button', { name: 'Quay lại' }));
  expect(screen).toHavePathname('/inventory');
  expect(
    await screen.findByRole('button', { name: COCA('12.000đ') }),
  ).toBeOnTheScreen();
});

test('nav pill switches tabs and keeps each screen alive', async () => {
  await openShop();
  await fireEvent.press(await screen.findByRole('button', { name: 'Tìm' }));
  await fireEvent.changeText(screen.getByLabelText('Tìm sản phẩm'), 'Coca');

  await fireEvent.press(screen.getByRole('tab', { name: 'Báo cáo' }));
  expect(screen).toHavePathname('/dashboard');
  expect(
    screen.getByRole('tab', { name: 'Báo cáo' }).props.accessibilityState,
  ).toMatchObject({ selected: true });

  await fireEvent.press(screen.getByRole('tab', { name: 'Tài khoản' }));
  expect(screen).toHavePathname('/account');

  await fireEvent.press(screen.getByRole('tab', { name: 'Kho' }));
  expect(screen).toHavePathname('/inventory');
  expect(screen.getByLabelText('Tìm sản phẩm').props.value).toBe('Coca');
});

test('camera FAB returns to the camera', async () => {
  await openShop();
  await fireEvent.press(screen.getByRole('button', { name: 'Mở camera' }));
  expect(screen).toHavePathname('/');
});

test('handle returns to the camera', async () => {
  await openShop();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Vuốt xuống: camera' }),
  );
  expect(screen).toHavePathname('/');
});
