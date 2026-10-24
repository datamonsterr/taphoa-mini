import type { Page } from '@playwright/test';
import {
  button,
  callApi,
  callInference,
  expect,
  expectDashboardShows,
  expectLiveVideo,
  formatVnd,
  openShopLoading,
  recordApi,
  seedTradingDay,
  test,
  waitForApi,
} from './fixtures';

const heading = (page: Page) => page.getByRole('heading', { name: 'Báo cáo' });
const period = (page: Page, name: 'Ngày' | 'Tuần' | 'Tháng') =>
  page.getByRole('radio', { name });
const pill = (page: Page, label: RegExp | string) =>
  page.getByRole('button', { name: label });

test.describe('dashboard', () => {
  test('an empty store shows zeros', async ({ page }) => {
    const report = await openShopLoading(
      page,
      '/dashboard',
      'GET',
      '/v1/reports/today',
    );
    expect(report.body).toMatchObject({ revenue: 0, sales_count: 0 });
    await expectDashboardShows(page, report.body);
    await expect(pill(page, /^0 món sắp hết$/)).toBeVisible();
  });

  test('day: the tiles are GET /v1/reports/today; the chart is the summary, one bar per day', async ({
    page,
    store,
  }) => {
    await seedTradingDay(store.api);
    const [today, summary] = await Promise.all([
      waitForApi(page, 'GET', '/v1/reports/today'),
      waitForApi(page, 'GET', '/v1/reports/summary'),
      page.goto('/dashboard'),
    ]);
    expect(today.body).toMatchObject({
      revenue: 40_000,
      sales_count: 3,
      cash_revenue: 30_000,
      transfer_revenue: 10_000,
      expenses: 3 * 9_500 + 5_000,
    });
    expect(today.body.net).toBe(40_000 - 3 * 9_500 - 5_000);
    await expect(heading(page)).toContainText('Hôm nay');
    await expectDashboardShows(page, today.body);

    // the server lists only the days with activity; the chart still has all seven
    expect(summary.requestHeaders).toBeTruthy();
    expect(summary.body.granularity).toBe('day');
    expect(summary.body.buckets).toHaveLength(1);
    expect(summary.body.buckets[0]).toMatchObject({
      revenue: 40_000,
      sales_count: 3,
    });
    await expect(
      page.getByRole('img', { name: 'Doanh thu và chi 7 ngày' }),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="bar-revenue-"]')).toHaveCount(7);
    // the newest bar is today and the tallest: it fills the 150 px plot
    await expect
      .poll(async () =>
        Math.max(
          ...(await page
            .locator('[data-testid^="bar-"]')
            .evaluateAll((els) =>
              els.map((el) => el.getBoundingClientRect().height),
            )),
        ),
      )
      .toBe(150);
  });

  test('week and month chips ask for their own summary and sales and show those figures; Ngày goes back', async ({
    page,
    store,
  }) => {
    await seedTradingDay(store.api);
    await Promise.all([
      waitForApi(page, 'GET', '/v1/reports/today'),
      page.goto('/dashboard'),
    ]);
    await expect(heading(page)).toContainText('Hôm nay');
    const dayRevenue = page.getByLabel(/^Doanh thu \d/);
    const day = await dayRevenue.getAttribute('aria-label');

    for (const [chip, title, granularity, bars] of [
      ['Tuần', 'Tuần này', 'week', 6],
      ['Tháng', 'Tháng này', 'month', 6],
    ] as const) {
      const sales = recordApi(page, 'GET', '/v1/sales');
      const [summary] = await Promise.all([
        waitForApi(page, 'GET', '/v1/reports/summary'),
        period(page, chip).click(),
      ]);
      expect(summary.body.granularity).toBe(granularity);
      await expect(heading(page)).toContainText(title);
      await expect(period(page, chip)).toBeChecked();
      await expect(page.locator('[data-testid^="bar-revenue-"]')).toHaveCount(
        bars,
      );
      // today's activity is in the newest bucket
      const current = summary.body.buckets.at(-1);
      expect(current).toMatchObject({ revenue: 40_000, sales_count: 3 });
      const [list] = await sales.stop();
      expect(list!.status).toBe(200);
      const sum = (method: string) =>
        list!.body.items
          .filter((s: any) => s.payment_method === method)
          .reduce((total: number, s: any) => total + s.total, 0);
      await expectDashboardShows(page, {
        revenue: current.revenue,
        sales_count: current.sales_count,
        cash_revenue: sum('cash'),
        transfer_revenue: sum('transfer'),
        expenses: current.expenses,
        net: current.net,
      });
    }

    await period(page, 'Ngày').click();
    await expect(heading(page)).toContainText('Hôm nay');
    await expect(dayRevenue).toHaveAttribute('aria-label', day!);
  });

  test('a store with no activity this week does not show an older week as this week', async ({
    page,
  }) => {
    const [, summary] = await Promise.all([
      waitForApi(page, 'GET', '/v1/reports/today'),
      waitForApi(page, 'GET', '/v1/reports/summary'),
      page.goto('/dashboard'),
    ]);
    expect(summary.body.buckets).toEqual([]);
    await period(page, 'Tuần').click();
    await expect(page.getByLabel(/^Doanh thu 0đ, 0 đơn$/)).toBeVisible();
    await expect(page.locator('[data-testid^="bar-revenue-"]')).toHaveCount(6);
  });
});

test.describe('dashboard alerts and review', () => {
  test('pills count what the server holds; the below-cost row is the alert and opens the product', async ({
    page,
    store,
  }) => {
    const day = await seedTradingDay(store.api);
    const [alerts, manual] = await Promise.all([
      waitForApi(page, 'GET', '/v1/alerts'),
      waitForApi(page, 'GET', '/v1/review/manual-lines'),
      page.goto('/dashboard'),
    ]);
    expect(alerts.body.items).toHaveLength(1);
    expect(manual.body.items).toHaveLength(1);
    const alert = alerts.body.items[0];
    expect(alert).toMatchObject({
      product_id: day.pepsi.id,
      selling_price: 9_000,
      cost_price: 9_500,
    });
    await expect(pill(page, /^0 món sắp hết$/)).toBeVisible();
    await expect(pill(page, /^1 món giá bán dưới giá nhập$/)).toBeVisible();
    await expect(pill(page, /^1 món bán không có trong kho$/)).toBeVisible();

    await pill(page, /dưới giá nhập$/).click();
    await expect(button(page, alert.product_name)).toBeVisible();
    await expect(
      page.getByText(
        `Giá bán ${formatVnd(alert.selling_price)} · giá nhập ${formatVnd(alert.cost_price)}`,
      ),
    ).toBeVisible();
    const detail = await callApi(
      page,
      'GET',
      `/v1/products/${alert.product_id}`,
      () => button(page, alert.product_name).click(),
    );
    await expect(page).toHaveURL(/\/product\//);
    await expect(
      page.getByRole('heading', { name: detail.body.name }),
    ).toBeVisible();
    await button(page, 'Quay lại').click();
    await expect(heading(page)).toBeVisible();
  });

  test('a loose item sold at a typed price: enroll it from the review list and the line is resolved', async ({
    page,
    store,
  }) => {
    await seedTradingDay(store.api);
    const manual = await openShopLoading(
      page,
      '/dashboard',
      'GET',
      '/v1/review/manual-lines',
    );
    const line = manual.body.items[0];
    expect(line).toMatchObject({
      manual_label: 'Kẹo lạc',
      quantity: 2,
      unit_price: 5_000,
      status: 'open',
    });
    await pill(page, /không có trong kho$/).click();
    await button(page, `Kẹo lạc × 2, ${formatVnd(line.unit_price)}`).click();
    await expect(page).toHaveURL(/\/enroll\?/);
    // the sheet opens with what was sold
    await expect(
      page.getByRole('textbox', { name: 'Tên (không bắt buộc)' }),
    ).toHaveValue('Kẹo lạc');
    await expect(page.getByLabel('Giá bán', { exact: true })).toHaveText(
      formatVnd(line.unit_price),
    );
    // a product needs a photo and the sale left none: shoot one
    const save = button(page, 'Lưu vào kho và thêm vào giỏ');
    await expect(page.getByText('0/5')).toBeVisible();
    await expect(save).toBeDisabled();
    await button(page, 'Thêm ảnh góc khác').click();
    const dialog = page.getByRole('dialog');
    await expectLiveVideo(dialog);
    await button(dialog, 'Chụp').click();
    await expect(save).toBeEnabled();

    const uploads = recordApi(page, 'POST', '/v1/images');
    const product = await callInference(page, 'POST', '/v1/products', () =>
      save.click(),
    );
    expect(await uploads.stop()).toHaveLength(1);
    expect(product.status).toBe(201);
    expect(product.requestBody).toMatchObject({
      name: 'Kẹo lạc',
      price: line.unit_price,
      from_manual_line_id: line.line_id,
    });
    expect(product.body).toMatchObject({ name: 'Kẹo lạc', price: 5_000 });

    // back on the dashboard the line is gone from the open list
    await expect(heading(page)).toBeVisible();
    await expect(pill(page, /^0 món bán không có trong kho$/)).toBeVisible();
    const open = await store.api.get('/v1/review/manual-lines?status=open');
    expect(open.items).toEqual([]);
    const resolved = await store.api.get(
      '/v1/review/manual-lines?status=resolved',
    );
    expect(resolved.items[0]).toMatchObject({
      line_id: line.line_id,
      resolution: { action: 'enrolled', product_id: product.body.id },
    });
  });
});
