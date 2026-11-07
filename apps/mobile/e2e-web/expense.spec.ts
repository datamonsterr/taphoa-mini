import type { Page } from '@playwright/test';
import {
  button,
  callApi,
  expect,
  expectDashboardShows,
  expectLiveVideo,
  formatVnd,
  keypad,
  openShop,
  recordApi,
  seedTradingDay,
  test,
  typeAmount,
  waitForApi,
} from './fixtures';

const heading = (page: Page) => page.getByRole('heading', { name: 'Báo cáo' });
const save = (page: Page) => button(page, 'Lưu khoản chi');
const category = (page: Page, name: string) =>
  page.getByRole('radio', { name, exact: true });

async function openExpense(page: Page) {
  await openShop(page, '/dashboard');
  await button(page, 'Thêm khoản chi').click();
  await expect(page).toHaveURL(/\/expense/);
  await expect(
    page.getByRole('heading', { name: 'Thêm chi phí' }),
  ).toBeVisible();
}

test.describe('add expense', () => {
  test('close returns to the dashboard without a request', async ({ page }) => {
    await openExpense(page);
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(r.url());
    });
    await button(page, 'Đóng').click();
    await expect(heading(page)).toBeVisible();
    expect(posts).toEqual([]);
  });

  test('save needs an amount (Nhập is preselected); the keypad edits the amount', async ({
    page,
  }) => {
    await openExpense(page);
    await expect(page.getByLabel('Số tiền chi')).toHaveText('−0đ');
    await expect(save(page)).toBeDisabled();
    await expect(category(page, 'Nhập')).toBeChecked();
    for (const name of ['Nhập', 'Điện', 'Nước', 'Khác']) {
      await category(page, name).click();
      await expect(category(page, name)).toBeChecked();
      await expect(page.getByRole('radio', { checked: true })).toHaveCount(1);
    }
    await keypad(page, ['1', '2', '3']);
    await expect(page.getByLabel('Số tiền chi')).toHaveText('−123đ');
    await expect(save(page)).toBeEnabled();
    await keypad(page, ['000']);
    await expect(page.getByLabel('Số tiền chi')).toHaveText('−123.000đ');
    for (let i = 0; i < 7; i += 1) await button(page, 'Xóa').click();
    await expect(page.getByLabel('Số tiền chi')).toHaveText('−0đ');
    await expect(save(page)).toBeDisabled();
  });

  test('save posts the expense; the dashboard shows the server totals', async ({
    page,
    store,
  }) => {
    await seedTradingDay(store.api);
    await openExpense(page);
    await category(page, 'Điện').click();
    await typeAmount(page, 5_000);
    await expect(page.getByLabel('Số tiền chi')).toHaveText('−5.000đ');

    const before = Date.now();
    const created = await callApi(page, 'POST', '/v1/expenses', () =>
      save(page).click(),
    );
    expect(created.status).toBe(201);
    expect(created.requestBody).toMatchObject({
      amount: 5_000,
      category: 'dien',
      paid_with: 'cash_box',
    });
    expect(created.requestBody.image_id).toBeUndefined();
    expect(
      Math.abs(Date.parse(created.requestBody.spent_at) - before),
    ).toBeLessThan(60_000);
    expect(created.body).toMatchObject({
      id: created.requestBody.id,
      amount: 5_000,
      category: 'dien',
    });

    // back on the dashboard, with what the server now reports
    await expect(heading(page)).toBeVisible();
    const report = await store.api.get('/v1/reports/today');
    // seeded: 3 × 9.500 purchase + 5.000 bill; this one makes 10.000 of bills
    expect(report.expenses).toBe(3 * 9_500 + 5_000 + 5_000);
    await expectDashboardShows(page, report);
    const listed = await store.api.get('/v1/expenses');
    expect(listed.items.map((e: any) => e.id)).toContain(created.body.id);
  });

  test('bill photo: cancel, capture, retake, use; the image is uploaded and attached', async ({
    page,
  }) => {
    await openExpense(page);
    await expect(page.getByLabel('Ảnh hóa đơn')).toHaveCount(0);

    await button(page, 'Chụp hóa đơn').click();
    await expectLiveVideo(page);
    await button(page, 'Đóng camera').click();
    await expect(page.locator('video')).toHaveCount(0);

    await button(page, 'Chụp hóa đơn').click();
    await expectLiveVideo(page);
    await button(page, 'Chụp').click();
    await expect(button(page, 'Dùng ảnh')).toBeVisible();
    await button(page, 'Chụp lại').click();
    await expectLiveVideo(page);
    await button(page, 'Chụp').click();
    await button(page, 'Dùng ảnh').click();
    await expect(page.getByLabel('Ảnh hóa đơn')).toBeVisible();
    await expect(page.locator('video')).toHaveCount(0);

    await category(page, 'Nước').click();
    await keypad(page, ['2', '000']);
    const upload = recordApi(page, 'POST', '/v1/images');
    const created = await callApi(page, 'POST', '/v1/expenses', () =>
      save(page).click(),
    );
    const [image] = await upload.stop();
    expect(image!.status).toBe(201);
    expect(image!.requestBody.multipart).toMatchObject({
      purpose: 'expense_receipt',
    });
    expect(created.requestBody).toMatchObject({
      amount: 2_000,
      category: 'nuoc',
      image_id: image!.body.id,
    });
    expect(created.body.image?.id).toBe(image!.body.id);
    await expect(heading(page)).toBeVisible();

    const [report] = await Promise.all([
      waitForApi(page, 'GET', '/v1/reports/today'),
      page.reload(),
    ]);
    expect(report.body.expenses).toBe(2_000);
    await expect(page.getByLabel(`Chi ${formatVnd(2_000)}`)).toBeVisible();
  });
});
