import {
  expect,
  expectDashboardShows,
  seedTradingDay,
  test,
  waitForApi,
} from './fixtures';

test.describe('void a sale', () => {
  test('void a sale and see the report change', async ({ page, store }) => {
    await seedTradingDay(store.api);
    const [before] = await Promise.all([
      waitForApi(page, 'GET', '/v1/reports/today'),
      page.goto('/dashboard'),
    ]);
    expect(before.body).toMatchObject({ revenue: 40_000, sales_count: 3 });
    await expectDashboardShows(page, before.body);

    await page.getByRole('button', { name: 'Đơn gần đây' }).click();
    await expect(
      page.getByRole('heading', { name: 'Đơn gần đây' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: /Đã thanh toán/ })
      .first()
      .click();
    await expect(
      page.getByRole('heading', { name: /^Đơn [A-Z0-9]{6}$/ }),
    ).toBeVisible();

    await page.getByLabel('Lý do hủy').fill('Khách trả hàng');
    await page.getByRole('button', { name: 'Hủy đơn / hoàn tiền' }).click();
    const voided = waitForApi(page, 'POST', /\/v1\/sales\/.+\/void/);
    await page.getByRole('button', { name: 'Xác nhận hủy' }).click();
    await voided;
    await expect(page.getByTestId('sale-status')).toHaveText('Đã hủy');

    const [after] = await Promise.all([
      waitForApi(page, 'GET', '/v1/reports/today'),
      page.goto('/dashboard'),
    ]);
    expect(after.body.sales_count).toBe(2);
    expect(after.body.revenue).toBeLessThan(before.body.revenue);
    await expectDashboardShows(page, after.body);
  });
});
