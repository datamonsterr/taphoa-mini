import type { Page } from '@playwright/test';
import {
  button,
  callApi,
  expect,
  formatVnd,
  keypad,
  openShop,
  seedTradingDay,
  test,
  type Api,
  typeAmount,
  waitForApi,
} from './fixtures';

const heading = (page: Page) => page.getByRole('heading', { name: 'Báo cáo' });
const save = (page: Page) => button(page, 'Chốt sổ hôm nay');
const counted = (page: Page) => page.getByLabel('Tiền đếm được');

/**
 * The trading day plus one big cash sale, so the drawer should hold a positive amount (the
 * keypad cannot type a negative count): 30.000 + 50.000 cash in, 28.500 + 5.000 out.
 */
async function seedDrawer(api: Api) {
  const day = await seedTradingDay(api);
  await api.createSale({
    lines: [{ product_id: day.coca.id, unit_price: 10_000, quantity: 5 }],
  });
  return day;
}

/** Dashboard -> Chốt sổ; returns the report the sheet loaded (expected cash). */
async function openClose(page: Page) {
  await openShop(page, '/dashboard');
  const [report, close] = await Promise.all([
    waitForApi(page, 'GET', '/v1/reports/today'),
    waitForApi(page, 'GET', /^\/v1\/day-closes\/\d{4}-\d\d-\d\d$/, 'ok').catch(
      () => null,
    ),
    button(page, 'Chốt sổ').click(),
  ]);
  await expect(page).toHaveURL(/\/close/);
  await expect(page.getByRole('heading', { name: 'Chốt sổ' })).toBeVisible();
  return { report, close };
}

test.describe('close the day', () => {
  test('the expected cash is the server figure; save stays disabled until digits', async ({
    page,
    store,
  }) => {
    await seedDrawer(store.api);
    const report = await store.api.get('/v1/reports/today');
    // 80.000 cash sales - 3 × 9.500 purchase - 5.000 bill, all from the cash box
    expect(report.expected_cash).toBe(80_000 - 3 * 9_500 - 5_000);
    await openClose(page);
    await expect(
      page.getByLabel(`Tiền mặt dự kiến ${formatVnd(report.expected_cash)}`),
    ).toBeVisible();
    await expect(save(page)).toBeDisabled();
    await keypad(page, ['5']);
    await expect(save(page)).toBeEnabled();
    await button(page, 'Xóa').click();
    await expect(save(page)).toBeDisabled();
    await button(page, 'Đóng').click();
    await expect(heading(page)).toBeVisible();
  });

  test('the difference pill follows the typed count: short, match, extra', async ({
    page,
    store,
  }) => {
    await seedDrawer(store.api);
    const { expected_cash: expected } =
      await store.api.get('/v1/reports/today');
    await openClose(page);

    await keypad(page, ['1']);
    await expect(counted(page)).toHaveText('1đ');
    await expect(
      page.getByLabel(`Thiếu ${formatVnd(expected - 1)}`),
    ).toBeVisible();
    await button(page, 'Xóa').click();
    await typeAmount(page, expected);
    await expect(counted(page)).toHaveText(formatVnd(expected));
    await expect(page.getByLabel('Khớp')).toBeVisible();
    await keypad(page, ['0']);
    await expect(
      page.getByLabel(`Dư ${formatVnd(expected * 10 - expected)}`),
    ).toBeVisible();
  });

  test('save puts the count; the server difference is what reopening shows, read-only', async ({
    page,
    store,
  }) => {
    await seedDrawer(store.api);
    const report = await store.api.get('/v1/reports/today');
    const expected: number = report.expected_cash;
    const countedCash = expected + 2_000;
    await openClose(page);
    await typeAmount(page, countedCash);
    await expect(page.getByLabel(`Dư ${formatVnd(2_000)}`)).toBeVisible();

    const put = await callApi(
      page,
      'PUT',
      `/v1/day-closes/${report.business_date}`,
      () => save(page).click(),
    );
    expect(put.requestBody).toMatchObject({ counted_cash: countedCash });
    expect(put.body).toMatchObject({
      business_date: report.business_date,
      counted_cash: countedCash,
      expected_cash: expected,
      difference: 2_000,
    });
    await expect(heading(page)).toBeVisible();

    // reopening loads the stored close and shows it read-only
    const reopened = await callApi(
      page,
      'GET',
      `/v1/day-closes/${report.business_date}`,
      () => button(page, 'Chốt sổ').click(),
    );
    expect(reopened.body.counted_cash).toBe(countedCash);
    await expect(page.getByText('Đã chốt sổ')).toBeVisible();
    await expect(counted(page)).toHaveText(
      formatVnd(reopened.body.counted_cash),
    );
    await expect(
      page.getByLabel(`Dư ${formatVnd(reopened.body.difference)}`),
    ).toBeVisible();
    await expect(button(page, '5')).toHaveCount(0);
    await expect(save(page)).toHaveCount(0);

    // and the day report carries the close
    const today = await store.api.get('/v1/reports/today');
    expect(today.day_close).toMatchObject({ counted_cash: countedCash });
  });
});
