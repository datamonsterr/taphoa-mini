import {
  fireGestureHandler,
  getByGestureTestId,
} from 'react-native-gesture-handler/jest-utils';

import { uploadPartsAsBlobs } from '@/features/camera/testing';
import {
  getDayClose,
  getTodayReport,
  listProducts,
  listSales,
} from '@/lib/api';
import * as images from '@/lib/api/images';
import { businessDate } from '@/lib/date';
import { formatVnd } from '@/lib/format';
import { PRODUCT_IDS, setMockScenario } from '@/test/mock';
import { useCartStore } from '@/stores/cart';
import { act, fireEvent, renderApp, screen, waitFor } from '@/test/router';

const press = (name: string | RegExp, role = 'button') =>
  fireEvent.press(screen.getByRole(role, { name }));

/** Full-screen app at the camera, with the upload made Node-safe. */
async function openCamera() {
  uploadPartsAsBlobs();
  const real = images.uploadImage;
  jest
    .spyOn(images, 'uploadImage')
    .mockImplementation((_file, purpose) =>
      real(new Blob(['x'], { type: 'image/jpeg' }), purpose),
    );
  await renderApp('/');
  expect(screen).toHavePathname('/');
}

async function shoot() {
  await press('Chụp');
  await waitFor(() => expect(screen.queryByTestId('scan-busy')).toBeNull());
}

async function swipeToShop() {
  await act(async () => {
    fireGestureHandler(getByGestureTestId('swipe-handle-pan'), [
      { state: 2 },
      { translationY: -90, velocityY: -300, state: 4 },
      { translationY: -90, velocityY: -300, state: 5 },
    ]);
  });
  await waitFor(() => expect(screen).toHavePathname('/inventory'));
}

/** Photographs the top match and adds it, leaving the camera with a cart pill. */
async function addTopMatch() {
  const create = jest.spyOn(images, 'createScan');
  await shoot();
  await screen.findByRole('button', { name: /đã chọn$/ });
  const top = (await create.mock.results[0]!.value).detections[0].candidates[0];
  await press('Thêm vào giỏ');
  return top as { product_id: string; price: number };
}

afterEach(() => jest.restoreAllMocks());

describe('journey', () => {
  it('(a) capture, add, cart, change qty, transfer QR, received -> sale stored', async () => {
    setMockScenario('match');
    await openCamera();
    const top = await addTopMatch();

    const pill = await screen.findByRole('button', {
      name: `Giỏ hàng: 1 món, ${formatVnd(top.price)}`,
    });
    await fireEvent.press(pill);
    expect(screen).toHavePathname('/cart');

    await press('Thêm một');
    const total = top.price * 2;
    expect(await screen.findByText(formatVnd(total))).toBeOnTheScreen();

    await press('Hiện mã QR thanh toán');
    expect(screen).toHavePathname('/pay');
    expect(
      await screen.findByLabelText(`Mã VietQR ${formatVnd(total)}`),
    ).toBeOnTheScreen();

    await press('Đã nhận tiền');
    await waitFor(() => expect(screen).toHavePathname('/'), { timeout: 4000 });

    const { items } = await listSales({ limit: 200 });
    const sale = items.find(
      (s) => s.total === total && s.payment_method === 'transfer',
    );
    expect(sale).toMatchObject({ status: 'completed' });
    expect(useCartStore.getState().lines).toEqual([]);
    expect(
      await screen.findByRole('button', { name: 'Giỏ hàng trống' }),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Chụp' })).toBeEnabled();
  });

  it('(b) cash with a note shows the change, then received', async () => {
    setMockScenario('match');
    await openCamera();
    const top = await addTopMatch();
    await fireEvent.press(
      await screen.findByRole('button', { name: /^Giỏ hàng: 1 món/ }),
    );
    await press('Hiện mã QR thanh toán');
    await press('Tiền mặt', 'radio');

    await fireEvent.press(screen.getByText('100.000'));
    expect(screen.getByLabelText('Tiền thối')).toHaveTextContent(
      formatVnd(100000 - top.price),
    );
    await press('Đã nhận tiền');
    await waitFor(() => expect(screen).toHavePathname('/'), { timeout: 4000 });

    const { items } = await listSales({ limit: 200 });
    expect(
      items.find((s) => s.payment_method === 'cash' && s.total === top.price),
    ).toMatchObject({ cash_received: 100000, status: 'completed' });
  });

  it('(c) unknown item: tag, enroll with a keypad price, product and cart line exist', async () => {
    setMockScenario('unknown');
    await openCamera();
    await shoot();
    await fireEvent.press(
      await screen.findByRole('button', {
        name: 'Chưa có trong kho, nhập giá',
      }),
    );
    expect(screen).toHavePathname('/enroll');

    await fireEvent.changeText(
      screen.getByLabelText('Tên (không bắt buộc)'),
      'Bánh quy',
    );
    for (const key of ['1', '5', '000']) await press(key);
    await press('Lưu vào kho và thêm vào giỏ');
    await waitFor(() => expect(screen).toHavePathname('/'));

    const { items } = await listProducts({ q: 'Bánh quy' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'Bánh quy', price: 15000 });
    expect(useCartStore.getState().lines).toMatchObject([
      { productId: items[0]!.id, price: 15000, qty: 1 },
    ]);
    expect(
      await screen.findByRole('button', {
        name: `Giỏ hàng: 1 món, ${formatVnd(15000)}`,
      }),
    ).toBeOnTheScreen();
  });

  it('(d) swipe to the shop, edit a price, return with the camera FAB', async () => {
    await openCamera();
    await swipeToShop();

    await fireEvent.press(
      await screen.findByRole('button', {
        name: 'Coca-Cola lon 330ml, 10.000đ',
      }),
    );
    expect(screen).toHavePathname(`/product/${PRODUCT_IDS.coca}`);
    await fireEvent.press(
      await screen.findByRole('button', { name: 'Sửa giá' }),
    );
    for (const key of ['Xóa', 'Xóa', 'Xóa', 'Xóa', 'Xóa', '1', '2', '000']) {
      await press(key);
    }
    await press('Lưu giá');
    expect(await screen.findByText('12.000đ')).toBeOnTheScreen();
    await press('Quay lại');
    expect(screen).toHavePathname('/inventory');
    expect(
      await screen.findByRole('button', {
        name: 'Coca-Cola lon 330ml, 12.000đ',
      }),
    ).toBeOnTheScreen();

    await press('Mở camera');
    expect(screen).toHavePathname('/');
    expect(screen.getByTestId('camera-view')).toBeOnTheScreen();
  });

  it('(e) reports tab: add an expense, close the day, the close is stored', async () => {
    await openCamera();
    await swipeToShop();
    await press('Báo cáo', 'tab');
    expect(screen).toHavePathname('/dashboard');

    const today = await getTodayReport();
    await press('Thêm khoản chi');
    expect(screen).toHavePathname('/expense');
    await press('5');
    await press('000');
    await press('Điện', 'radio');
    await press('Lưu khoản chi');
    await waitFor(() => expect(screen).toHavePathname('/dashboard'));

    await press('Chốt sổ');
    await waitFor(() => expect(screen).toHavePathname('/close'));
    const expected = (await getTodayReport()).expected_cash!;
    expect(expected).toBe(today.expected_cash! - 5000);
    await screen.findByLabelText(`Tiền mặt dự kiến ${formatVnd(expected)}`);
    for (const digit of String(expected)) await press(digit);
    await press('Chốt sổ hôm nay');
    await waitFor(() => expect(screen).toHavePathname('/dashboard'));

    expect(await getDayClose(businessDate())).toMatchObject({
      counted_cash: expected,
      difference: 0,
    });
  });

  it('(f) account tab: switching to EN changes the labels', async () => {
    await openCamera();
    await swipeToShop();
    await press('Tài khoản', 'tab');
    expect(screen).toHavePathname('/account');
    expect(await screen.findByText('Chủ')).toBeOnTheScreen();

    await press('EN', 'radio');
    expect(screen.getByText('Owner')).toBeOnTheScreen();
    expect(screen.queryByText('Chủ')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Account' })).toBeOnTheScreen();
    expect(
      screen.getByRole('switch', { name: 'Elder mode' }),
    ).toBeOnTheScreen();
  });
});
