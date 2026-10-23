import {
  addCocaAndOpenCart,
  button,
  cartPill,
  expect,
  openCamera,
  shutter,
  test,
} from './fixtures';

const qty = (page: Parameters<typeof button>[0], n: number) =>
  page.getByLabel(`Số lượng ${n}`);

test.describe('cart sheet', () => {
  test('stepper + and − change quantity and total; trash at qty 1 removes the line', async ({
    page,
  }) => {
    await addCocaAndOpenCart(page);
    await expect(page.getByText('Coca-Cola lon 330ml')).toBeVisible();
    await expect(qty(page, 1)).toBeVisible();
    await expect(
      page.getByTestId('sheet-panel').getByLabel('1 món', { exact: true }),
    ).toBeVisible();
    // qty 1: the minus is a trash button
    await expect(button(page, 'Bớt một')).toHaveCount(0);

    await button(page, 'Thêm một').click();
    await expect(qty(page, 2)).toBeVisible();
    await expect(page.getByText('20.000đ').last()).toBeVisible();
    await expect(
      page.getByTestId('sheet-panel').getByLabel('2 món', { exact: true }),
    ).toBeVisible();

    await button(page, 'Bớt một').click();
    await expect(qty(page, 1)).toBeVisible();
    await expect(page.getByText('10.000đ').last()).toBeVisible();

    await button(page, 'Xóa').click();
    await expect(page.getByText('Giỏ hàng trống')).toBeVisible();
    await expect(button(page, 'Hiện mã QR thanh toán')).toHaveCount(0);
  });

  test('close sheet keeps the cart on the camera', async ({ page }) => {
    await addCocaAndOpenCart(page);
    await button(page, 'Đóng').click();
    await expect(page).not.toHaveURL(/\/cart/);
    await expect(shutter(page)).toBeVisible();
    await expect(cartPill(page)).toHaveAccessibleName(
      'Giỏ hàng: 1 món, 10.000đ',
    );
  });

  test('empty cart: the camera button returns to the camera', async ({
    page,
  }) => {
    await openCamera(page);
    await cartPill(page).click();
    await expect(page).toHaveURL(/\/cart/);
    await expect(page.getByText('Giỏ hàng trống')).toBeVisible();
    await button(page, 'Về máy ảnh').click();
    await expect(page).not.toHaveURL(/\/cart/);
    await expect(shutter(page)).toBeEnabled();
    await expect(button(page, 'Giỏ hàng trống')).toBeVisible();
  });

  test('QR button opens the payment screen', async ({ page }) => {
    await addCocaAndOpenCart(page);
    await button(page, 'Hiện mã QR thanh toán').click();
    await expect(page).toHaveURL(/\/pay/);
    await expect(
      page.getByRole('radiogroup', { name: 'Cách trả' }),
    ).toBeVisible();
  });
});

test.describe('payment', () => {
  test.beforeEach(async ({ page }) => {
    await addCocaAndOpenCart(page);
    await button(page, 'Hiện mã QR thanh toán').click();
    await expect(page).toHaveURL(/\/pay/);
  });

  test('transfer shows a VietQR svg and the bank text', async ({ page }) => {
    const qr = page.getByRole('img', { name: 'Mã VietQR 10.000đ' });
    await expect(qr).toBeVisible();
    await expect(qr.locator('svg')).toBeVisible();
    await expect(page.getByText('VCB · 0123 456 789')).toBeVisible();
    // One bank line, as on the board; the holder is only in the accessible name.
    await expect(page.getByText('NGUYEN THI BA')).toHaveCount(0);
    await expect(
      page.getByLabel('NGUYEN THI BA, VCB 0123 456 789'),
    ).toBeVisible();
    await expect(page.getByText('10.000đ').first()).toBeVisible();
    await expect(page.getByLabel('Món trong đơn')).toBeVisible();
  });

  test('back chevron returns to the cart', async ({ page }) => {
    await button(page, 'Quay lại giỏ hàng').click();
    await expect(page).toHaveURL(/\/cart/);
  });

  test('cash toggle and every quick note show the right change', async ({
    page,
  }) => {
    await page.getByRole('radio', { name: 'Tiền mặt' }).click();
    await expect(page.getByRole('img', { name: /Mã VietQR/ })).toHaveCount(0);
    const change = page.getByLabel('Tiền thối');
    await expect(change).toHaveText('0đ');
    await button(page, 'Đủ tiền').click();
    await expect(change).toHaveText('0đ');
    for (const [note, back] of [
      ['50.000', '40.000đ'],
      ['100.000', '90.000đ'],
      ['200.000', '190.000đ'],
      ['500.000', '490.000đ'],
    ] as const) {
      await button(page, note).click();
      await expect(change).toHaveText(back);
    }
    // toggling back to transfer shows the QR again
    await page.getByRole('radio', { name: 'Chuyển khoản' }).click();
    await expect(
      page.getByRole('img', { name: 'Mã VietQR 10.000đ' }),
    ).toBeVisible();
  });

  test('received: success, back on the camera with an empty cart pill', async ({
    page,
  }) => {
    await page.getByRole('radio', { name: 'Tiền mặt' }).click();
    await button(page, '100.000').click();
    await button(page, 'Đã nhận tiền').click();
    await expect(page.getByLabel('Đã nhận tiền xong')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(shutter(page)).toBeVisible();
    await expect(button(page, 'Giỏ hàng trống')).toBeVisible();
  });

  test('received by transfer also empties the cart', async ({ page }) => {
    await button(page, 'Đã nhận tiền').click();
    await expect(page).toHaveURL(/\/$/);
    await expect(button(page, 'Giỏ hàng trống')).toBeVisible();
  });
});
