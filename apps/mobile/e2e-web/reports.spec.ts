import type { Page } from '@playwright/test';
import {
  button,
  expect,
  expectLiveVideo,
  keypad,
  openShop,
  test,
  vnd,
} from './fixtures';

const heading = (page: Page) => page.getByRole('heading', { name: 'Báo cáo' });
const revenue = (page: Page) => page.getByLabel(/^Doanh thu \d/);
const expenseTile = (page: Page) => page.getByLabel(/^Chi \d/);
const netTile = (page: Page) => page.getByLabel(/^Lãi /);
const period = (page: Page, name: 'Ngày' | 'Tuần' | 'Tháng') =>
  page.getByRole('radio', { name });
const pill = (page: Page, label: RegExp) =>
  page.getByRole('button', { name: label });
const amount = async (locator: ReturnType<Page['getByLabel']>) =>
  vnd((await locator.getAttribute('aria-label'))!.split(',')[0]!);

test.describe('dashboard periods', () => {
  test('the tallest bar fills the 150px plot', async ({ page }) => {
    await openShop(page, '/dashboard');
    const bars = page.locator('[data-testid^="bar-"]');
    await expect(bars).toHaveCount(14);
    await expect
      .poll(async () =>
        Math.max(
          ...(await bars.evaluateAll((els) =>
            els.map((el) => el.getBoundingClientRect().height),
          )),
        ),
      )
      .toBe(150);
    const plot = page.getByRole('img', { name: 'Doanh thu và chi 7 ngày' });
    expect((await plot.boundingBox())!.height).toBe(150);
  });

  test('chips switch title, chart and numbers', async ({ page }) => {
    await openShop(page, '/dashboard');
    await expect(heading(page)).toContainText('Hôm nay');
    await expect(period(page, 'Ngày')).toBeChecked();
    await expect(
      page.getByRole('img', { name: 'Doanh thu và chi 7 ngày' }),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="bar-revenue-"]')).toHaveCount(7);
    const day = await amount(revenue(page));
    expect(day).toBeGreaterThan(0);

    await period(page, 'Tuần').click();
    await expect(heading(page)).toContainText('Tuần này');
    await expect(period(page, 'Tuần')).toBeChecked();
    await expect(period(page, 'Ngày')).not.toBeChecked();
    await expect(
      page.getByRole('img', { name: 'Doanh thu và chi 6 tuần' }),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="bar-revenue-"]')).toHaveCount(6);
    await expect.poll(() => amount(revenue(page))).toBeGreaterThan(day);
    const week = await amount(revenue(page));

    await period(page, 'Tháng').click();
    await expect(heading(page)).toContainText('Tháng này');
    await expect(
      page.getByRole('img', { name: 'Doanh thu và chi 6 tháng' }),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="bar-revenue-"]')).toHaveCount(6);
    await expect.poll(() => amount(revenue(page))).toBeGreaterThanOrEqual(week);

    await period(page, 'Ngày').click();
    await expect(heading(page)).toContainText('Hôm nay');
    await expect.poll(() => amount(revenue(page))).toBe(day);
  });

  test('stat tiles: revenue, cash, transfer, expense and profit', async ({
    page,
  }) => {
    await openShop(page, '/dashboard');
    for (const label of [
      /^Doanh thu \d/,
      /^Tiền mặt \d/,
      /^Chuyển khoản \d/,
      /^Chi \d/,
      /^Lãi /,
    ]) {
      await expect(page.getByLabel(label)).toBeVisible();
    }
    const cash = vnd(
      (await page.getByLabel(/^Tiền mặt \d/).getAttribute('aria-label'))!,
    );
    const transfer = vnd(
      (await page.getByLabel(/^Chuyển khoản \d/).getAttribute('aria-label'))!,
    );
    expect(cash + transfer).toBe(await amount(revenue(page)));
  });
});

test.describe('dashboard alerts', () => {
  test('three pills with counts; price and manual lists expand and collapse', async ({
    page,
  }) => {
    await openShop(page, '/dashboard');
    await expect(pill(page, /^3 món sắp hết$/)).toBeVisible();
    await expect(pill(page, /^2 món giá bán dưới giá nhập$/)).toBeVisible();
    await expect(pill(page, /^3 món bán không có trong kho$/)).toBeVisible();

    await pill(page, /dưới giá nhập$/).click();
    await expect(button(page, 'Pepsi lon 330ml')).toBeVisible();
    await expect(button(page, 'Nước mắm Nam Ngư 500ml')).toBeVisible();
    await expect(
      page.getByText('Giá bán 9.000đ · giá nhập 9.500đ'),
    ).toBeVisible();
    await pill(page, /không có trong kho$/).click();
    await expect(button(page, 'Pepsi lon 330ml')).toHaveCount(0);
    await expect(button(page, 'Kẹo lạc × 2, 5.000đ')).toBeVisible();
    await expect(button(page, 'Bánh tráng × 1, 8.000đ')).toBeVisible();
    await expect(button(page, 'Rau thơm × 1, 12.000đ')).toBeVisible();
    await pill(page, /không có trong kho$/).click();
    await expect(button(page, 'Kẹo lạc × 2, 5.000đ')).toHaveCount(0);
  });

  test('margin row opens the product', async ({ page }) => {
    await openShop(page, '/dashboard');
    await pill(page, /dưới giá nhập$/).click();
    await button(page, 'Nước mắm Nam Ngư 500ml').click();
    await expect(page).toHaveURL(/\/product\//);
    await expect(
      page.getByRole('heading', { name: 'Nước mắm Nam Ngư 500ml' }),
    ).toBeVisible();
  });

  test('manual line opens enroll prefilled; saving resolves the line', async ({
    page,
  }) => {
    await openShop(page, '/dashboard');
    await pill(page, /không có trong kho$/).click();
    await button(page, 'Kẹo lạc × 2, 5.000đ').click();
    await expect(page).toHaveURL(/\/enroll\?/);
    await expect(
      page.getByRole('textbox', { name: 'Tên (không bắt buộc)' }),
    ).toHaveValue('Kẹo lạc');
    await expect(page.getByLabel('Giá bán', { exact: true })).toHaveText(
      '5.000đ',
    );
    // the seeded manual line has no crop photo: a product needs one, so shoot an angle first
    const save = button(page, 'Lưu vào kho và thêm vào giỏ');
    await expect(page.getByText('0/5')).toBeVisible();
    await expect(save).toBeDisabled();
    await button(page, 'Thêm ảnh góc khác').click();
    const dialog = page.getByRole('dialog');
    await expectLiveVideo(dialog);
    await button(dialog, 'Chụp').click();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(heading(page)).toBeVisible();
    await expect(pill(page, /^2 món bán không có trong kho$/)).toBeVisible();
  });
});

test.describe('add expense', () => {
  test('close returns to the dashboard', async ({ page }) => {
    await openShop(page, '/dashboard');
    await button(page, 'Thêm khoản chi').click();
    await expect(page).toHaveURL(/\/expense/);
    await button(page, 'Đóng').click();
    await expect(heading(page)).toBeVisible();
  });

  test('categories, keypad and the save button state', async ({ page }) => {
    await openShop(page, '/dashboard');
    await button(page, 'Thêm khoản chi').click();
    const save = button(page, 'Lưu khoản chi');
    await expect(
      page.getByRole('heading', { name: 'Thêm chi phí' }),
    ).toBeVisible();
    await expect(page.getByLabel('Số tiền chi')).toHaveText('−0đ');
    await expect(save).toBeDisabled();
    for (const name of ['Nhập', 'Điện', 'Nước', 'Khác']) {
      await page.getByRole('radio', { name, exact: true }).click();
      await expect(
        page.getByRole('radio', { name, exact: true }),
      ).toBeChecked();
      await expect(page.getByRole('radio', { checked: true })).toHaveCount(1);
    }
    await keypad(page, ['1', '2', '3']);
    await expect(page.getByLabel('Số tiền chi')).toHaveText('−123đ');
    await expect(save).toBeEnabled();
    await button(page, 'Xóa').click();
    await expect(page.getByLabel('Số tiền chi')).toHaveText('−12đ');
    await keypad(page, ['000']);
    await expect(page.getByLabel('Số tiền chi')).toHaveText('−12.000đ');
    await button(page, 'Xóa').click();
    await button(page, 'Xóa').click();
    await button(page, 'Xóa').click();
    await button(page, 'Xóa').click();
    await button(page, 'Xóa').click();
    await expect(save).toBeDisabled();
  });

  test('bill photo: cancel, capture, retake, use', async ({ page }) => {
    await openShop(page, '/dashboard');
    await button(page, 'Thêm khoản chi').click();
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
  });

  test('save: the dashboard expense grows and profit drops', async ({
    page,
  }) => {
    await openShop(page, '/dashboard');
    await expect(expenseTile(page)).toBeVisible();
    const before = await amount(expenseTile(page));
    const profitBefore = (await netTile(page).getAttribute('aria-label'))!;

    await button(page, 'Thêm khoản chi').click();
    await page.getByRole('radio', { name: 'Điện', exact: true }).click();
    await keypad(page, ['5', '000']);
    await button(page, 'Chụp hóa đơn').click();
    await expectLiveVideo(page);
    await button(page, 'Chụp').click();
    await button(page, 'Dùng ảnh').click();
    await button(page, 'Lưu khoản chi').click();

    await expect(heading(page)).toBeVisible();
    await expect.poll(() => amount(expenseTile(page))).toBe(before + 5000);
    expect(await netTile(page).getAttribute('aria-label')).not.toBe(
      profitBefore,
    );
  });
});

test.describe('close the day', () => {
  const open = async (page: Page) => {
    await openShop(page, '/dashboard');
    await button(page, 'Chốt sổ').click();
    await expect(page).toHaveURL(/\/close/);
    await expect(page.getByRole('heading', { name: 'Chốt sổ' })).toBeVisible();
  };
  const save = (page: Page) => button(page, 'Chốt sổ hôm nay');
  const expected = async (page: Page) =>
    vnd(
      (await page.getByLabel(/^Tiền mặt dự kiến /).getAttribute('aria-label'))!,
    );

  test('save is disabled until digits; delete clears; close returns', async ({
    page,
  }) => {
    await open(page);
    await expect(save(page)).toBeDisabled();
    await keypad(page, ['5']);
    await expect(save(page)).toBeEnabled();
    await button(page, 'Xóa').click();
    await expect(save(page)).toBeDisabled();
    await button(page, 'Đóng').click();
    await expect(heading(page)).toBeVisible();
  });

  test('difference pill shows short, match and extra', async ({ page }) => {
    await open(page);
    const exp = await expected(page);
    expect(exp).toBeGreaterThan(0);
    const counted = page.getByLabel('Tiền đếm được');

    await keypad(page, ['1']);
    await expect(counted).toHaveText('1đ');
    await expect(page.getByLabel(/^Thiếu /)).toBeVisible();

    await button(page, 'Xóa').click();
    for (const digit of String(exp)) {
      await keypad(page, [digit]);
    }
    await expect(counted).toHaveText(`${exp.toLocaleString('vi-VN')}đ`);
    await expect(page.getByLabel('Khớp')).toBeVisible();

    await keypad(page, ['0']);
    await expect(page.getByLabel(/^Dư /)).toBeVisible();
    await keypad(page, ['000']);
    await expect(page.getByLabel(/^Dư /)).toBeVisible();
  });

  test('save closes the day; reopening is read-only', async ({ page }) => {
    await open(page);
    const exp = await expected(page);
    for (const digit of String(exp)) await keypad(page, [digit]);
    await save(page).click();
    await expect(heading(page)).toBeVisible();

    await button(page, 'Chốt sổ').click();
    await expect(page.getByText('Đã chốt sổ')).toBeVisible();
    await expect(page.getByLabel('Tiền đếm được')).toHaveText(
      `${exp.toLocaleString('vi-VN')}đ`,
    );
    await expect(page.getByLabel('Khớp')).toBeVisible();
    await expect(button(page, '5')).toHaveCount(0);
    await expect(save(page)).toHaveCount(0);
  });
});
