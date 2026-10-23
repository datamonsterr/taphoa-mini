import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import {
  addButton,
  addCocaAndOpenCart,
  button,
  expect,
  keypad,
  openCamera,
  openEnrollFromUnknown,
  openShop,
  reshoot,
  shoot,
  test,
} from './fixtures';

const DIR = path.join(__dirname, 'screenshots');

/** Waits for every image to finish loading and animations to start settling, then saves the page. */
async function capture(page: Page, testInfo: TestInfo, board: string) {
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.images].every((image) => image.complete),
      ),
    )
    .toBe(true);
  const file = path.join(DIR, `${board}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await testInfo.attach(board, { path: file, contentType: 'image/png' });
}

test.describe('board screenshots', () => {
  test('Main: live camera', async ({ page }, testInfo) => {
    await openCamera(page);
    await capture(page, testInfo, 'Main');
  });

  test('Match: one item recognised', async ({ page }, testInfo) => {
    await openCamera(page);
    await shoot(page);
    await expect(
      page.getByRole('button', { name: /xem món khác$/ }),
    ).toBeVisible();
    await capture(page, testInfo, 'Match');
  });

  test('Multi: three items selected', async ({ page }, testInfo) => {
    await openCamera(page);
    await button(page, 'Nhiều món').click();
    await shoot(page);
    await expect(page.getByTestId('box-badge')).toHaveCount(3);
    await capture(page, testInfo, 'Multi');
  });

  test('Unknown: low match', async ({ page }, testInfo) => {
    await openCamera(page);
    await shoot(page);
    await reshoot(page).click();
    await shoot(page);
    await reshoot(page).click();
    await button(page, 'Chụp').click();
    await expect(button(page, 'Chưa có trong kho, nhập giá')).toBeVisible();
    await expect(addButton(page)).toBeDisabled();
    await capture(page, testInfo, 'Unknown');
  });

  test('Enroll: price a new product', async ({ page }, testInfo) => {
    await openEnrollFromUnknown(page);
    await keypad(page, ['1', '5', '000']);
    await expect(page.getByLabel('Giá bán', { exact: true })).toHaveText(
      '15.000đ',
    );
    await capture(page, testInfo, 'Enroll');
  });

  test('Cart: lines and QR button', async ({ page }, testInfo) => {
    await addCocaAndOpenCart(page);
    await button(page, 'Thêm một').click();
    await expect(page.getByLabel('Số lượng 2')).toBeVisible();
    await capture(page, testInfo, 'Cart');
  });

  test('Pay: VietQR', async ({ page }, testInfo) => {
    await addCocaAndOpenCart(page);
    await button(page, 'Hiện mã QR thanh toán').click();
    await expect(
      page.getByRole('img', { name: /Mã VietQR/ }).locator('svg'),
    ).toBeVisible();
    await capture(page, testInfo, 'Pay');
  });

  test('Inventory: stock grid', async ({ page }, testInfo) => {
    await openShop(page, '/inventory');
    await expect(
      page.getByRole('button', { name: /, (còn|sắp hết)/ }),
    ).toHaveCount(12);
    await capture(page, testInfo, 'Inventory');
  });

  test('Product: detail', async ({ page }, testInfo) => {
    await openShop(page, '/inventory');
    await page
      .getByRole('button', { name: /^Coca-Cola lon 330ml, 10\.000đ/ })
      .click();
    await expect(page.getByLabel('Ảnh 1 trên 2')).toBeVisible();
    await capture(page, testInfo, 'Product');
  });

  test('Dashboard: reports (390x1080)', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 1080 });
    await openShop(page, '/dashboard');
    await expect(
      page.getByRole('button', { name: /món sắp hết$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('img', { name: /^Doanh thu và chi/ }),
    ).toBeVisible();
    await capture(page, testInfo, 'Dashboard');
  });

  test('Expense: add an expense', async ({ page }, testInfo) => {
    await openShop(page, '/dashboard');
    await button(page, 'Thêm khoản chi').click();
    await page.getByRole('radio', { name: 'Điện', exact: true }).click();
    await keypad(page, ['5', '000', '0']);
    await expect(page.getByLabel('Số tiền chi')).toHaveText('−50.000đ');
    await capture(page, testInfo, 'Expense');
  });

  test('Account: members and settings', async ({ page }, testInfo) => {
    await openShop(page, '/account');
    await expect(page.getByLabel('3 thành viên')).toBeVisible();
    await capture(page, testInfo, 'Account');
  });

  test('Close: close the day', async ({ page }, testInfo) => {
    await openShop(page, '/dashboard');
    await button(page, 'Chốt sổ').click();
    await keypad(page, ['1', '0', '000']);
    await expect(page.getByLabel(/^Thiếu |^Dư |^Khớp/)).toBeVisible();
    await capture(page, testInfo, 'Close');
  });
});
