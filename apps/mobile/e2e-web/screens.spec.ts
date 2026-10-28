import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import {
  type Api,
  button,
  cartPill,
  createNewcomer,
  expect,
  fillEnroll,
  formatVnd,
  goOffline,
  goShop,
  hydrate,
  keypad,
  openCamera,
  openShop,
  pricePill,
  scanAndAdd,
  seedScannableProduct,
  seedTradingDay,
  shoot,
  signInAs,
  signInScreen,
  test,
  typeAmount,
  unknownPill,
  uuid7,
  welcomeScreen,
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

test.describe('issue #88 screenshots', () => {
  test('RecentSales and SaleDetail', async ({ page, store }, testInfo) => {
    await seedTradingDay(store.api);
    await openShop(page, '/dashboard');
    await button(page, 'Đơn gần đây').click();
    await expect(
      page.getByRole('heading', { name: 'Đơn gần đây' }),
    ).toBeVisible();
    const sale = page.getByRole('button', { name: /Đã thanh toán/ }).first();
    await expect(sale).toBeVisible();
    await capture(page, testInfo, 'RecentSales');

    await sale.click();
    await expect(
      page.getByRole('heading', { name: /Chi tiết đơn/ }),
    ).toBeVisible();
    await capture(page, testInfo, 'SaleDetail');

    await page.getByLabel('Lý do hủy').fill('Khách trả hàng');
    await button(page, 'Hủy đơn / hoàn tiền').click();
    await button(page, 'Xác nhận hủy').click();
    await expect(page.getByTestId('sale-status')).toHaveText('Đã hủy');
    await capture(page, testInfo, 'SaleDetailVoided');
  });

  test('ExportSheet', async ({ page, store }, testInfo) => {
    await seedTradingDay(store.api);
    await openShop(page, '/dashboard');
    await button(page, 'Xuất giao dịch').click();
    await expect(page.getByTestId('export-sheet')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Xuất giao dịch' }),
    ).toBeInViewport();
    await expect(button(page, 'Tải và chia sẻ')).toBeInViewport();
    await capture(page, testInfo, 'ExportSheet');
  });

  test('ProductUnits', async ({ page, store }, testInfo) => {
    await seedTradingDay(store.api);
    await openShop(page, '/inventory');
    await button(page, /^Coca-Cola lon 330ml, /).click();
    await expect(
      page.getByRole('heading', { name: 'Coca-Cola lon 330ml' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Đơn vị bán' }),
    ).toBeVisible();
    await button(page, 'Thêm đơn vị').click();
    await expect(page.getByTestId('unit-sheet')).toBeVisible();
    await expect(page.getByLabel('Tên đơn vị')).toBeInViewport();
    await capture(page, testInfo, 'ProductUnits');
  });
});

test.describe('onboarding screenshots', () => {
  test.use({ signedIn: false });

  test('Sign in', async ({ page }, testInfo) => {
    // the pay screen returns to the camera by itself; a reload would need the network
    await hydrate(page, signInScreen(page));
    await capture(page, testInfo, 'SignIn');
  });

  test('Welcome and the create form', async ({ page }, testInfo) => {
    // a Clerk user without a store: signing in lands on the welcome screen
    await signInAs(page, await createNewcomer());
    await hydrate(page, welcomeScreen(page));
    await capture(page, testInfo, 'Welcome');
    await page.getByTestId('onboarding-create').click();
    await expect(
      page.getByRole('textbox', { name: 'Tên cửa hàng' }),
    ).toBeVisible();
    await capture(page, testInfo, 'Create');
  });
});

const COCA = { name: 'Coca-Cola lon 330ml', price: 10_000, cost_price: 7_500 };
const PEPSI = { name: 'Pepsi lon 330ml', price: 9_000, cost_price: 7_000 };

/** Two products with stock, so the Kho grid has tiles to sell from. */
async function seedShelf(api: Api) {
  const coca = await api.createProduct(COCA);
  const pepsi = await api.createProduct(PEPSI);
  await api.createExpense({
    amount: 10 * COCA.cost_price + 10 * PEPSI.cost_price,
    category: 'nhap_hang',
    purchase_lines: [
      { product_id: coca.id, quantity: 10, unit_cost: COCA.cost_price },
      { product_id: pepsi.id, quantity: 10, unit_cost: PEPSI.cost_price },
    ],
  });
  return { coca, pepsi };
}

/** A customer who already owes `owed` through a credit sale. */
async function seedDebtor(
  api: Api,
  productId: string,
  name: string,
  owed: number,
  phone = '0912345678',
) {
  const customer = await api.post('/v1/customers', {
    id: uuid7(),
    name,
    phone,
  });
  const id = uuid7();
  await api.post(
    '/v1/sales',
    {
      id,
      sold_at: new Date().toISOString(),
      payment_method: 'credit',
      total: owed,
      credit: { customer_id: customer.id, amount: owed },
      lines: [
        {
          id: uuid7(),
          source: 'grid',
          product_id: productId,
          quantity: 1,
          unit_price: owed,
        },
      ],
    },
    { 'Idempotency-Key': id },
  );
  return customer;
}

/** Waits until a sheet or screen has finished animating into the viewport. */
const settled = async (locator: ReturnType<Page['locator']>) => {
  await expect(locator).toBeInViewport({ ratio: 0.9 });
  // a sheet keeps sliding after it is first in view: wait until it stops moving
  let last = '';
  await expect
    .poll(async () => {
      const now = JSON.stringify(await locator.boundingBox());
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
};

/** Grid -> cart -> pay screen with `count` Coca sold. */
async function openPay(page: Page, coca: { name: string }, count = 1) {
  await openShop(page, '/inventory');
  const add = page.getByRole('button', { name: `Thêm ${coca.name} vào giỏ` });
  await expect(add).toBeVisible();
  for (let i = 0; i < count; i++) await add.click();
  await cartPill(page).click();
  await button(page, 'Hiện mã QR thanh toán').click();
  await expect(page).toHaveURL(/\/pay/);
  await expect(
    page.getByRole('radiogroup', { name: 'Cách trả' }),
  ).toBeVisible();
}

test.describe('issue #78 screenshots', () => {
  test('PayToggleWords: three worded segments', async ({
    page,
    store,
  }, testInfo) => {
    const { coca } = await seedShelf(store.api);
    await store.api.setBank();
    await openPay(page, coca, 2);
    for (const name of ['Chuyển khoản', 'Tiền mặt', 'Ghi nợ'])
      await expect(
        page.getByRole('radio', { name, exact: true }),
      ).toBeVisible();
    await capture(page, testInfo, 'PayToggleWords');
  });

  test('PayCredit: credit with a customer', async ({
    page,
    store,
  }, testInfo) => {
    const { coca } = await seedShelf(store.api);
    await seedDebtor(store.api, coca.id, 'Chị Lan', 30_000);
    await openPay(page, coca, 2);
    await page.getByRole('radio', { name: 'Ghi nợ', exact: true }).click();
    await button(page, /^Chị Lan, /).click();
    await expect(
      button(page, `Ghi nợ ${formatVnd(2 * COCA.price)}`),
    ).toBeVisible();
    await expect(page.getByText(/^Đang nợ /)).toBeVisible();
    await expect(page.getByText(/^Nợ mới của khách /)).toBeVisible();
    await expect(page.getByText('Trả trước', { exact: true })).toBeVisible();
    await settled(button(page, `Ghi nợ ${formatVnd(2 * COCA.price)}`));
    await capture(page, testInfo, 'PayCredit');
  });

  test('CustomerPickerCreate: add sheet from the debt book', async ({
    page,
    store,
  }, testInfo) => {
    const { coca } = await seedShelf(store.api);
    await seedDebtor(store.api, coca.id, 'Chị Lan', 30_000);
    await openShop(page, '/dashboard');
    await button(page, /^Sổ nợ, /).click();
    await button(page, 'Thêm khách hàng').click();
    await page
      .getByRole('textbox', { name: 'Tên khách hàng' })
      .fill('Anh Minh');
    await page
      .getByRole('textbox', { name: 'Số điện thoại (không bắt buộc)' })
      .fill('0987654321');
    await expect(button(page, 'Chọn từ danh bạ')).toBeVisible();
    await settled(button(page, 'Chọn từ danh bạ'));
    await settled(button(page, 'Tạo khách hàng'));
    await capture(page, testInfo, 'CustomerPickerCreate');
  });

  test('DebtBookAdd: debt book header with the add circle', async ({
    page,
    store,
  }, testInfo) => {
    const { coca } = await seedShelf(store.api);
    await seedDebtor(store.api, coca.id, 'Chị Lan', 30_000);
    await seedDebtor(store.api, coca.id, 'Anh Tuấn', 12_000, '0901112223');
    await openShop(page, '/dashboard');
    await button(page, /^Sổ nợ, /).click();
    await expect(page.getByRole('heading', { name: 'Sổ nợ' })).toBeVisible();
    await expect(button(page, 'Thêm khách hàng')).toBeVisible();
    await expect(button(page, /^Chị Lan, /)).toBeVisible();
    await expect(button(page, /^Anh Tuấn, /)).toBeVisible();
    await capture(page, testInfo, 'DebtBookAdd');
  });

  test('DuplicateGuard: same name asks before creating', async ({
    page,
    store,
  }, testInfo) => {
    const { coca } = await seedShelf(store.api);
    await seedDebtor(store.api, coca.id, 'Chị Lan', 30_000);
    await openShop(page, '/dashboard');
    await button(page, /^Sổ nợ, /).click();
    await button(page, 'Thêm khách hàng').click();
    await page.getByRole('textbox', { name: 'Tên khách hàng' }).fill('chi lan');
    await button(page, 'Tạo khách hàng').click();
    await expect(page.getByText('Dùng khách này?')).toBeVisible();
    await expect(button(page, 'Vẫn tạo khách mới')).toBeVisible();
    await settled(button(page, 'Vẫn tạo khách mới'));
    await capture(page, testInfo, 'DuplicateGuard');
  });
});

test.describe('issue #86 screenshots', () => {
  test('GridSell: tiles with + and the cart pill', async ({
    page,
    store,
  }, testInfo) => {
    const { coca, pepsi } = await seedShelf(store.api);
    await openShop(page, '/inventory');
    await page
      .getByRole('button', { name: `Thêm ${coca.name} vào giỏ` })
      .click();
    await page
      .getByRole('button', { name: `Thêm ${pepsi.name} vào giỏ` })
      .click();
    await expect(cartPill(page)).toHaveAccessibleName(
      `Giỏ hàng: 2 món, ${formatVnd(COCA.price + PEPSI.price)}`,
    );
    await settled(cartPill(page));
    await capture(page, testInfo, 'GridSell');
  });

  test('ElderGrid: elder mode on, bigger tiles', async ({
    page,
    store,
  }, testInfo) => {
    const { coca } = await seedShelf(store.api);
    await openShop(page, '/account');
    await page.getByRole('switch', { name: 'Chế độ người lớn tuổi' }).click();
    await expect(
      page.getByRole('switch', { name: 'Chế độ người lớn tuổi' }),
    ).toBeChecked();
    await goShop(page, 'Kho');
    await expect(
      page.getByRole('button', { name: `Thêm ${coca.name} vào giỏ` }),
    ).toBeVisible();
    await capture(page, testInfo, 'ElderGrid');
  });

  test('AccountSpeak: Đọc to số tiền toggle', async ({
    page,
    store,
  }, testInfo) => {
    await store.api.setBank();
    await openShop(page, '/account');
    const speak = page.getByRole('switch', { name: 'Đọc to số tiền' });
    await speak.scrollIntoViewIfNeeded();
    await speak.click();
    await expect(speak).toBeChecked();
    await settled(speak);
    await capture(page, testInfo, 'AccountSpeak');
  });
});

test.describe('issue #87 screenshots', () => {
  const HINT = 'Không có mạng. Bán bằng Kho: giá và đơn vẫn lưu được.';

  test('OfflineHint: camera says to sell from the grid', async ({
    page,
    store,
  }, testInfo) => {
    await seedShelf(store.api);
    await openCamera(page);
    await goOffline(page);
    await expect(page.getByText(HINT)).toBeVisible();
    await expect(button(page, /Mở Kho để bán/)).toBeVisible();
    await settled(button(page, /Mở Kho để bán/));
    await capture(page, testInfo, 'OfflineHint');
  });

  test('OfflineGridSale, OfflineSynced: offline sale, outbox, replay', async ({
    page,
    store,
  }, testInfo) => {
    const { coca } = await seedShelf(store.api);
    await openShop(page, '/inventory');
    const add = page.getByRole('button', { name: `Thêm ${coca.name} vào giỏ` });
    await expect(add).toBeVisible();
    await goOffline(page);
    await add.click();
    await add.click();
    await cartPill(page).click();
    await button(page, 'Hiện mã QR thanh toán').click();
    await page.getByRole('radio', { name: 'Tiền mặt' }).click();
    await button(page, '50.000').click();
    await button(page, 'Đã nhận tiền').click();
    await expect(page.getByLabel('Đã nhận tiền xong')).toBeVisible();
    // the check zooms in from nothing: wait until it covers the screen
    await expect
      .poll(
        async () =>
          (await page.getByLabel('Đã nhận tiền xong').boundingBox())?.width,
      )
      .toBeGreaterThanOrEqual(380);
    await capture(page, testInfo, 'OfflineGridSale');

    // pending outbox indicator on the camera overlay
    // the pay screen returns to the camera by itself; a reload would need the network
    await expect(page.getByText(HINT)).toBeVisible();
    await expect(page.getByText('1 đơn chờ gửi khi có mạng')).toBeVisible();
    await capture(page, testInfo, 'OfflineOutbox');

    // back online: the sale posts and the reports count it
    const replay = page.waitForResponse(
      (r) => r.url().endsWith('/v1/sales') && r.request().method() === 'POST',
    );
    await page.context().setOffline(false);
    expect((await replay).status()).toBe(201);
    await expect(page.getByText('1 đơn chờ gửi khi có mạng')).toHaveCount(0);
    await openShop(page, '/dashboard');
    await expect(
      page.getByText(formatVnd(2 * COCA.price)).first(),
    ).toBeVisible();
    await capture(page, testInfo, 'OfflineSynced');
  });
});
