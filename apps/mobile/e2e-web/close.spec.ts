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

/** Saves a screenshot for the issue evidence when E2E_SHOTS names a directory. */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  // let the sheet finish sliding up before the picture
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

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

/** A cash sale of loose goods only: no catalog, so no model is needed to seed it. */
async function seedLooseDrawer(api: Api) {
  await api.createSale({
    lines: [{ manual_label: 'Kẹo lạc', unit_price: 25_000, quantity: 2 }],
  });
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
  test('the keypad is the board 3 x 4 grid and the pill shows the signed amount (#210)', async ({
    page,
    store,
  }) => {
    await seedLooseDrawer(store.api);
    const report = await store.api.get('/v1/reports/today');
    const expected: number = report.expected_cash;
    await openClose(page);
    const box = async (name: string) => {
      const b = await button(page, name).boundingBox();
      expect(b).not.toBeNull();
      return b!;
    };
    const [one, two, three, four, zero, del] = await Promise.all(
      ['1', '2', '3', '4', '0', 'Xóa'].map(box),
    );
    // three columns: 1-2-3 share a row, 4 starts the next one, 0 sits in the middle column
    expect(Math.abs(one.y - two.y)).toBeLessThan(2);
    expect(Math.abs(two.y - three.y)).toBeLessThan(2);
    expect(four.y).toBeGreaterThan(one.y + one.height - 1);
    expect(Math.abs(four.x - one.x)).toBeLessThan(2);
    expect(Math.abs(zero.x - two.x)).toBeLessThan(2);
    expect(Math.abs(del.x - three.x)).toBeLessThan(2);
    await typeAmount(page, expected - 10_000);
    await expect(
      page.getByLabel('Thiếu 10.000đ').getByText('−10.000đ'),
    ).toBeVisible();
    await shot(page, 'close-open');
  });

  test('sales that arrive after the close are announced and the day can be closed again (#202)', async ({
    page,
    store,
  }) => {
    await seedLooseDrawer(store.api);
    const report = await store.api.get('/v1/reports/today');
    const path = `/v1/day-closes/${report.business_date}`;
    await store.api.put(path, { counted_cash: report.expected_cash });
    await store.api.createSale({
      lines: [{ manual_label: 'Nước ngọt', unit_price: 10_000 }],
    });
    await store.api.createSale({
      lines: [{ manual_label: 'Kẹo lạc', unit_price: 1_000 }],
    });
    const now = await store.api.get('/v1/reports/today');
    expect(now.expected_cash).toBe(report.expected_cash + 11_000);
    await openClose(page);
    await expect(page.getByTestId('close-late-notice')).toContainText(
      '2 giao dịch phát sinh sau khi chốt sổ',
    );
    await expect(
      page.getByLabel(`Tiền mặt dự kiến ${formatVnd(now.expected_cash)}`),
    ).toBeVisible();
    await expect(page.getByLabel('Thiếu 11.000đ')).toBeVisible();
    await shot(page, 'close-late-sales');

    await typeAmount(page, now.expected_cash);
    await expect(page.getByLabel('Khớp')).toBeVisible();
    const put = await callApi(page, 'PUT', path, () =>
      button(page, 'Chốt sổ lại').click(),
    );
    expect(put.body).toMatchObject({
      counted_cash: now.expected_cash,
      expected_cash: now.expected_cash,
    });
    expect((await store.api.get(path)).late_sales_count).toBe(0);

    // reopening: closed again, read-only, no notice
    await button(page, 'Chốt sổ').click();
    await expect(page.getByText('Đã chốt sổ')).toBeVisible();
    await expect(page.getByTestId('close-late-notice')).toHaveCount(0);
  });
});
