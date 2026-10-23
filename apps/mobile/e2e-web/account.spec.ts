import type { Page } from '@playwright/test';
import { button, expect, openShop, test } from './fixtures';

const elderSwitch = (page: Page, name = 'Chế độ người lớn tuổi') =>
  page.getByRole('switch', { name });
const scaleText = (page: Page) => page.getByText(/^\d+%$/);

test.describe('account', () => {
  test('store, members and the bank row', async ({ page }) => {
    await openShop(page, '/account');
    await expect(
      page.getByRole('heading', { name: 'Tạp hóa Cô Ba' }),
    ).toBeVisible();
    await expect(page.getByText('Chủ', { exact: true })).toBeVisible();
    await expect(page.getByLabel('3 thành viên')).toBeVisible();
    await expect(button(page, 'Mời bằng mã QR')).toBeVisible();
    await expect(button(page, 'Tài khoản ngân hàng VietQR')).toContainText(
      'VCB · 0123 456 789',
    );
  });

  test('invite opens a QR sheet with token and expiry; the sheet closes', async ({
    page,
  }) => {
    await openShop(page, '/account');
    await button(page, 'Mời bằng mã QR').click();
    const sheet = page.getByTestId('sheet-panel');
    await expect(
      sheet.getByRole('heading', { name: 'Mã mời vào cửa hàng' }),
    ).toBeVisible();
    await expect(sheet.locator('svg').first()).toBeVisible();
    await expect(sheet.getByText(/^Hết hạn lúc /)).toBeVisible();
    await page.getByTestId('sheet-scrim').click({ position: { x: 10, y: 10 } });
    await expect(sheet).toHaveCount(0);
  });

  test('bank sheet: validation errors, then save updates the row', async ({
    page,
  }) => {
    await openShop(page, '/account');
    await button(page, 'Tài khoản ngân hàng VietQR').click();
    const sheet = page.getByTestId('sheet-panel');
    await expect(
      sheet.getByRole('heading', { name: 'Tài khoản nhận tiền' }),
    ).toBeVisible();
    const bank = sheet.getByRole('textbox', { name: 'Ngân hàng', exact: true });
    const bin = sheet.getByRole('textbox', { name: 'Mã BIN ngân hàng' });
    const number = sheet.getByRole('textbox', { name: 'Số tài khoản' });
    const holder = sheet.getByRole('textbox', { name: 'Chủ tài khoản' });
    await expect(bank).toHaveValue('VCB');
    await expect(bin).toHaveValue('970436');

    await bin.fill('123');
    await number.fill('12');
    await holder.fill('');
    await button(sheet, 'Lưu').click();
    await expect(sheet.getByText('Mã BIN gồm 6 chữ số')).toBeVisible();
    await expect(sheet.getByText('Số tài khoản gồm 4–19 ký tự')).toBeVisible();
    await expect(sheet.getByText('Nhập tên chủ tài khoản')).toBeVisible();

    await bank.fill('Techcombank');
    await bin.fill('970407');
    await number.fill('9876543210');
    await holder.fill('Trần Thị Bé');
    await expect(holder).toHaveValue('TRAN THI BE');
    await button(sheet, 'Lưu').click();
    await expect(sheet).toHaveCount(0);
    await expect(button(page, 'Tài khoản ngân hàng VietQR')).toContainText(
      'Techcombank · 9876 543 210',
    );
  });

  test('elder mode floors the text size; text size +/− steps and hits the limits', async ({
    page,
  }) => {
    await openShop(page, '/account');
    await expect(elderSwitch(page)).not.toBeChecked();
    await expect(scaleText(page)).toHaveText('100%');
    await expect(button(page, 'Chữ nhỏ hơn')).toBeDisabled();

    await button(page, 'Chữ to hơn').click();
    await expect(scaleText(page)).toHaveText('125%');
    await expect(button(page, 'Chữ nhỏ hơn')).toBeEnabled();
    await button(page, 'Chữ nhỏ hơn').click();
    await expect(scaleText(page)).toHaveText('100%');

    await elderSwitch(page).click();
    await expect(elderSwitch(page)).toBeChecked();
    await expect(scaleText(page)).toHaveText('125%');
    await expect(button(page, 'Chữ nhỏ hơn')).toBeDisabled();
    for (const next of ['150%', '175%', '200%']) {
      await button(page, 'Chữ to hơn').click();
      await expect(scaleText(page)).toHaveText(next);
    }
    await expect(button(page, 'Chữ to hơn')).toBeDisabled();
    await button(page, 'Chữ nhỏ hơn').click();
    await expect(scaleText(page)).toHaveText('175%');

    await elderSwitch(page).click();
    await expect(elderSwitch(page)).not.toBeChecked();
  });

  test('VI/EN toggle changes the labels', async ({ page }) => {
    await openShop(page, '/account');
    await expect(page.getByRole('radio', { name: 'VI' })).toBeChecked();
    await page.getByRole('radio', { name: 'EN' }).click();
    await expect(page.getByRole('radio', { name: 'EN' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'VI' })).not.toBeChecked();
    await expect(page.getByText('Owner', { exact: true })).toBeVisible();
    await expect(page.getByLabel('3 members')).toBeVisible();
    await expect(button(page, 'Invite with QR code')).toBeVisible();
    await expect(button(page, 'VietQR bank account')).toBeVisible();
    await expect(elderSwitch(page, 'Elder mode')).toBeVisible();
    await expect(button(page, 'Larger text')).toBeVisible();
    await expect(button(page, 'Smaller text')).toBeVisible();
    await expect(
      page.getByRole('tab', { name: 'Stock', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('tab', { name: 'Reports', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('tab', { name: 'Account', exact: true }),
    ).toBeVisible();

    await button(page, 'Invite with QR code').click();
    await expect(
      page.getByRole('heading', { name: 'Store invite code' }),
    ).toBeVisible();
    await page.getByTestId('sheet-scrim').click({ position: { x: 10, y: 10 } });

    await page.getByRole('radio', { name: 'VI' }).click();
    await expect(button(page, 'Mời bằng mã QR')).toBeVisible();
  });

  test('settings persist across a reload', async ({ page }) => {
    await openShop(page, '/account');
    await page.getByRole('radio', { name: 'EN' }).click();
    await elderSwitch(page, 'Elder mode').click();
    await button(page, 'Larger text').click();
    await expect(scaleText(page)).toHaveText('150%');

    await page.reload();
    await expect(page.getByRole('tablist')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'EN' })).toBeChecked();
    await expect(elderSwitch(page, 'Elder mode')).toBeChecked();
    await expect(scaleText(page)).toHaveText('150%');
    await expect(button(page, 'Invite with QR code')).toBeVisible();
  });
});
