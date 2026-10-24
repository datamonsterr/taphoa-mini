import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import {
  button,
  cartPill,
  expect,
  fillEnroll,
  hydrate,
  keypad,
  openCamera,
  openShop,
  pricePill,
  scanAndAdd,
  seedScannableProduct,
  seedTradingDay,
  shoot,
  test,
  typeAmount,
  unknownPill,
} from './fixtures';

/**
 * One screenshot per board, taken against the real backend (real recognition, real data). The
 * pictures are build artifacts for review, not pixel baselines: nothing is compared.
 */
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

  test('Match: one item recognised', async ({ page, store }, testInfo) => {
    await seedScannableProduct(store.api);
    await openCamera(page);
    await shoot(page);
    await expect(pricePill(page)).toBeVisible();
    await capture(page, testInfo, 'Match');
  });

  test('Multi: every detection boxed', async ({ page, store }, testInfo) => {
    await seedScannableProduct(store.api);
    await openCamera(page);
    await button(page, 'Nhiều món').click();
    await shoot(page, 'multi');
    await capture(page, testInfo, 'Multi');
  });

  test('Unknown: nothing in the catalog matches', async ({
    page,
  }, testInfo) => {
    await openCamera(page);
    await shoot(page);
    await expect(unknownPill(page)).toBeVisible();
    await capture(page, testInfo, 'Unknown');
  });

  test('Enroll: price a new product', async ({ page }, testInfo) => {
    await openCamera(page);
    await shoot(page);
    await unknownPill(page).click();
    await fillEnroll(page, { name: 'Kẹo dừa', price: 15_000 });
    await capture(page, testInfo, 'Enroll');
  });

  test('Cart: lines and QR button', async ({ page, store }, testInfo) => {
    const coca = await seedScannableProduct(store.api);
    await openCamera(page);
    await scanAndAdd(page, coca);
    await cartPill(page).click();
    await button(page, 'Thêm một').click();
    await expect(page.getByLabel('Số lượng 2')).toBeVisible();
    await capture(page, testInfo, 'Cart');
  });

  test('Pay: VietQR', async ({ page, store }, testInfo) => {
    await store.api.setBank();
    const coca = await seedScannableProduct(store.api);
    await openCamera(page);
    await scanAndAdd(page, coca);
    await cartPill(page).click();
    await button(page, 'Hiện mã QR thanh toán').click();
    await expect(
      page.getByRole('img', { name: /Mã VietQR/ }).locator('svg'),
    ).toBeVisible();
    await capture(page, testInfo, 'Pay');
  });

  test('Inventory: stock grid', async ({ page, store }, testInfo) => {
    await seedTradingDay(store.api);
    await openShop(page, '/inventory');
    await expect(button(page, /^Coca-Cola lon 330ml, /)).toBeVisible();
    await capture(page, testInfo, 'Inventory');
  });

  test('Product: detail', async ({ page, store }, testInfo) => {
    await seedTradingDay(store.api);
    await openShop(page, '/inventory');
    await button(page, /^Coca-Cola lon 330ml, /).click();
    await expect(
      page.getByRole('heading', { name: 'Coca-Cola lon 330ml' }),
    ).toBeVisible();
    await capture(page, testInfo, 'Product');
  });

  test('Dashboard: reports (390x1080)', async ({ page, store }, testInfo) => {
    await seedTradingDay(store.api);
    await page.setViewportSize({ width: 390, height: 1080 });
    await openShop(page, '/dashboard');
    await expect(
      page.getByRole('button', { name: /dưới giá nhập$/ }),
    ).toHaveText('1');
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

  test('Account: members and settings', async ({ page, store }, testInfo) => {
    await store.api.setBank();
    await openShop(page, '/account');
    await expect(page.getByLabel('1 thành viên')).toBeVisible();
    await capture(page, testInfo, 'Account');
  });

  test('Close: close the day', async ({ page, store }, testInfo) => {
    await seedTradingDay(store.api);
    await openShop(page, '/dashboard');
    await button(page, 'Chốt sổ').click();
    await typeAmount(page, 10_000);
    await expect(page.getByLabel(/^Thiếu |^Dư |^Khớp/)).toBeVisible();
    await capture(page, testInfo, 'Close');
  });
});

test.describe('onboarding screenshots', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('Welcome and the create form', async ({ page }, testInfo) => {
    await page.goto('/');
    await hydrate(page, button(page, 'Tạo cửa hàng'));
    await capture(page, testInfo, 'Welcome');
    await button(page, 'Tạo cửa hàng').click();
    await expect(
      page.getByRole('textbox', { name: 'Tên cửa hàng' }),
    ).toBeVisible();
    await capture(page, testInfo, 'Create');
  });
});
