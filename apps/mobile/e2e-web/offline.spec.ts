import {
  button,
  cartPill,
  expect,
  expectDashboardShows,
  formatVnd,
  goOffline,
  openShop,
  test,
  uuid7,
  waitForApi,
} from './fixtures';

/**
 * PRD NFR Offline: with the network off the grid, manual price and cash sale still work, and the
 * sale reaches the server once, exactly once, after the network returns. The browser really goes
 * offline (`context.setOffline`); nothing is intercepted.
 */

const COCA = { name: 'Coca-Cola lon 330ml', price: 10_000, cost_price: 7_500 };

test.describe('offline sale', () => {
  test('network off: sell from the grid in cash; network on: the sale posts once and the reports count it', async ({
    page,
    store,
  }) => {
    const coca = await store.api.createProduct(COCA);
    // a purchase does not start stock tracking; a count does
    await store.api.post(
      `/v1/products/${coca.id}/stock-adjustments`,
      { count: 10 },
      { 'Idempotency-Key': uuid7() },
    );

    // online first: the catalog lands in the on-device cache
    await openShop(page, '/inventory');
    const addTile = page.getByRole('button', {
      name: `Thêm ${coca.name} vào giỏ`,
    });
    await expect(addTile).toBeVisible();

    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/v1/sales'))
        posts.push(request.postData() ?? '');
    });

    await goOffline(page);
    await expect(addTile).toBeVisible();

    // sell two from the grid, pay cash
    await addTile.click();
    await addTile.click();
    const total = 2 * coca.price;
    await expect(cartPill(page)).toHaveAccessibleName(
      `Giỏ hàng: 2 món, ${formatVnd(total)}`,
    );
    await cartPill(page).click();
    await button(page, 'Hiện mã QR thanh toán').click();
    await expect(page).toHaveURL(/\/pay/);
    await page.getByRole('radio', { name: 'Tiền mặt' }).click();
    await button(page, '50.000').click();
    await button(page, 'Đã nhận tiền').click();
    await expect(page.getByLabel('Đã nhận tiền xong')).toBeVisible();
    expect(posts).toEqual([]);

    // network on: the outbox replays the sale
    const replay = waitForApi(page, 'POST', '/v1/sales');
    await page.context().setOffline(false);
    const sale = await replay;
    expect(sale.status).toBe(201);
    expect(sale.requestBody).toMatchObject({
      payment_method: 'cash',
      total,
      cash_received: 50_000,
      lines: [{ product_id: coca.id, quantity: 2, unit_price: coca.price }],
    });
    expect(posts).toHaveLength(1);

    // the reports count it once, and the server stock matches the screen
    const [report] = await Promise.all([
      waitForApi(page, 'GET', '/v1/reports/today'),
      openShop(page, '/dashboard'),
    ]);
    expect(report.body).toMatchObject({
      revenue: total,
      cash_revenue: total,
      sales_count: 1,
    });
    await expectDashboardShows(page, report.body);
    const product = await store.api.get(`/v1/products/${coca.id}`);
    expect(product.stock_quantity).toBe(8);
    expect(posts).toHaveLength(1);
  });
});
