import {
  addButton,
  button,
  callApi,
  cartPill,
  expect,
  expectDashboardShows,
  formatVnd,
  openCamera,
  openShop,
  scanAndAdd,
  seedScannableProduct,
  shutter,
  test,
  waitForApi,
} from './fixtures';

/**
 * Cart, payment and the sale record. The catalog has one product, enrolled with the very picture
 * the fake camera shows, so the real models match it on every shot.
 */

const COCA = { name: 'Coca-Cola lon 330ml', price: 10_000, cost_price: 7_500 };

test.describe('cart sheet', () => {
  test('stepper, remove and close change the cart the camera shows', async ({
    page,
    store,
  }) => {
    const coca = await seedScannableProduct(store.api, COCA);
    await openCamera(page);
    await scanAndAdd(page, coca);
    await expect(cartPill(page)).toHaveAccessibleName(
      `Giỏ hàng: 1 món, ${formatVnd(coca.price)}`,
    );

    await cartPill(page).click();
    await expect(page).toHaveURL(/\/cart/);
    await expect(page.getByText(coca.name)).toBeVisible();
    await expect(page.getByLabel('Số lượng 1')).toBeVisible();
    // qty 1: the minus is a trash button
    await expect(button(page, 'Bớt một')).toHaveCount(0);

    await button(page, 'Thêm một').click();
    await expect(page.getByLabel('Số lượng 2')).toBeVisible();
    await expect(
      page.getByText(formatVnd(2 * coca.price)).last(),
    ).toBeVisible();
    await button(page, 'Bớt một').click();
    await expect(page.getByLabel('Số lượng 1')).toBeVisible();
    await expect(page.getByText(formatVnd(coca.price)).last()).toBeVisible();

    // close keeps the cart on the camera
    await button(page, 'Đóng').click();
    await expect(page).not.toHaveURL(/\/cart/);
    await expect(shutter(page)).toBeVisible();
    await expect(cartPill(page)).toHaveAccessibleName(
      `Giỏ hàng: 1 món, ${formatVnd(coca.price)}`,
    );

    // the trash button at quantity 1 empties it
    await cartPill(page).click();
    await button(page, 'Xóa').click();
    await expect(page.getByText('Giỏ hàng trống')).toBeVisible();
    await expect(button(page, 'Hiện mã QR thanh toán')).toHaveCount(0);
    await button(page, 'Về máy ảnh').click();
    await expect(button(page, 'Giỏ hàng trống')).toBeVisible();
    await expect(addButton(page)).toBeDisabled();
  });
});

test.describe('checkout and payment', () => {
  test('transfer: the QR shows the store bank; "Đã nhận tiền" posts the sale and the dashboard counts it', async ({
    page,
    store,
  }) => {
    const bank = (await store.api.setBank()).bank_account;
    const coca = await seedScannableProduct(store.api, COCA);
    await openCamera(page);
    const scan = await scanAndAdd(page, coca);
    await cartPill(page).click();

    // the pay screen loads the bank account from the server
    const loaded = await callApi(page, 'GET', '/v1/store', () =>
      button(page, 'Hiện mã QR thanh toán').click(),
    );
    expect(loaded.body.bank_account).toMatchObject(bank);
    await expect(page).toHaveURL(/\/pay/);
    await expect(
      page.getByRole('img', { name: `Mã VietQR ${formatVnd(coca.price)}` }),
    ).toBeVisible();
    await expect(page.getByText('VCB · 0123 456 789')).toBeVisible();
    await expect(
      page.getByLabel(`${bank.account_name}, VCB 0123 456 789`),
    ).toBeVisible();
    await expect(page.getByLabel('Món trong đơn')).toBeVisible();

    // received: one POST /v1/sales, idempotent by its own id
    const sale = await callApi(page, 'POST', '/v1/sales', () =>
      button(page, 'Đã nhận tiền').click(),
    );
    expect(sale.status).toBe(201);
    expect(sale.requestHeaders['idempotency-key']).toBe(sale.requestBody.id);
    expect(sale.requestBody).toMatchObject({
      payment_method: 'transfer',
      total: coca.price,
      scan_ids: [scan.body.id],
      lines: [
        {
          product_id: coca.id,
          quantity: 1,
          unit_price: coca.price,
          source: 'camera',
          detection_id: scan.body.detections[0].id,
          suggested_product_id: coca.id,
        },
      ],
    });
    expect(sale.requestBody.cash_received).toBeUndefined();
    expect(sale.body).toMatchObject({
      id: sale.requestBody.id,
      total: coca.price,
      payment_method: 'transfer',
      status: 'completed',
    });
    expect(sale.body.lines).toHaveLength(1);
    expect(sale.body.vietqr_memo).toBe(sale.requestBody.vietqr_memo);

    // success, then the camera with an empty cart
    await expect(page.getByLabel('Đã nhận tiền xong')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(button(page, 'Giỏ hàng trống')).toBeVisible();

    // the server holds exactly that sale ...
    const sales = await store.api.get('/v1/sales');
    expect(sales.items.map((s: any) => s.id)).toEqual([sale.body.id]);

    // ... and the dashboard shows the day's report as the server computed it
    const [report] = await Promise.all([
      waitForApi(page, 'GET', '/v1/reports/today'),
      openShop(page, '/dashboard'),
    ]);
    expect(report.body).toMatchObject({
      revenue: coca.price,
      sales_count: 1,
      transfer_revenue: coca.price,
      cash_revenue: 0,
    });
    await expectDashboardShows(page, report.body);
  });

  test('cash: every quick note shows its change; the sale records what was handed over', async ({
    page,
    store,
  }) => {
    const coca = await seedScannableProduct(store.api, COCA);
    await openCamera(page);
    await scanAndAdd(page, coca);
    // a second unit: the sale line carries the quantity
    await scanAndAdd(page, coca);
    const total = 2 * coca.price;
    await expect(cartPill(page)).toHaveAccessibleName(
      `Giỏ hàng: 2 món, ${formatVnd(total)}`,
    );
    await cartPill(page).click();
    await button(page, 'Hiện mã QR thanh toán').click();
    await expect(page).toHaveURL(/\/pay/);

    await page.getByRole('radio', { name: 'Tiền mặt' }).click();
    await expect(page.getByRole('img', { name: /Mã VietQR/ })).toHaveCount(0);
    const change = page.getByLabel('Tiền thối');
    await expect(change).toHaveText('0đ');
    for (const note of [50_000, 100_000, 200_000, 500_000]) {
      await button(page, formatVnd(note).replace('đ', '')).click();
      await expect(change).toHaveText(formatVnd(note - total));
    }
    await button(page, '100.000').click();
    await expect(change).toHaveText(formatVnd(100_000 - total));

    const sale = await callApi(page, 'POST', '/v1/sales', () =>
      button(page, 'Đã nhận tiền').click(),
    );
    expect(sale.status).toBe(201);
    expect(sale.requestBody).toMatchObject({
      payment_method: 'cash',
      total,
      cash_received: 100_000,
      lines: [{ product_id: coca.id, quantity: 2, unit_price: coca.price }],
    });
    // the change on screen is what the server worked out
    expect(sale.body.change_given).toBe(100_000 - total);
    expect(sale.body.total).toBe(total);
    await expect(page.getByLabel('Đã nhận tiền xong')).toBeVisible();
    await expect(button(page, 'Giỏ hàng trống')).toBeVisible();

    const [report] = await Promise.all([
      waitForApi(page, 'GET', '/v1/reports/today'),
      openShop(page, '/dashboard'),
    ]);
    expect(report.body).toMatchObject({
      revenue: total,
      cash_revenue: total,
      transfer_revenue: 0,
      sales_count: 1,
    });
    await expectDashboardShows(page, report.body);
  });

  test('without a bank account the QR says so; cash still works', async ({
    page,
    store,
  }) => {
    const coca = await seedScannableProduct(store.api, COCA);
    await openCamera(page);
    await scanAndAdd(page, coca);
    await cartPill(page).click();
    const loaded = await callApi(page, 'GET', '/v1/store', () =>
      button(page, 'Hiện mã QR thanh toán').click(),
    );
    expect(loaded.body.bank_account ?? null).toBeNull();
    await expect(page.getByText('Chưa có tài khoản ngân hàng')).toBeVisible();
    await expect(page.getByRole('img', { name: /Mã VietQR/ })).toHaveCount(0);
    // cash still works
    await page.getByRole('radio', { name: 'Tiền mặt' }).click();
    await expect(button(page, 'Đã nhận tiền')).toBeEnabled();
  });
});
