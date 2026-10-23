import {
  button,
  cartPill,
  expect,
  expectLiveVideo,
  keypad,
  openCamera,
  openEnrollFromUnknown,
  test,
} from './fixtures';
import type { Page } from '@playwright/test';

const save = (page: Page) => button(page, 'Lưu vào kho và thêm vào giỏ');
const price = (page: Page) => page.getByLabel('Giá bán', { exact: true });

async function addAngle(page: Page) {
  await button(page, 'Thêm ảnh góc khác').click();
  const dialog = page.getByRole('dialog');
  await expectLiveVideo(dialog);
  await button(dialog, 'Chụp').click();
  await expect(dialog).toHaveCount(0);
}

test.describe('enroll', () => {
  test('from a low match: photo 1/5, close returns to the camera', async ({
    page,
  }) => {
    await openEnrollFromUnknown(page);
    await expect(page.getByLabel('1 trên 5 ảnh')).toBeVisible();
    await expect(page.getByText('1/5')).toBeVisible();
    await expect(save(page)).toBeDisabled();
    await button(page, 'Đóng').click();
    await expect(page).not.toHaveURL(/\/enroll/);
  });

  test('add angle: cancel keeps the count, capture raises n/5 up to 5', async ({
    page,
  }) => {
    await openEnrollFromUnknown(page);
    await button(page, 'Thêm ảnh góc khác').click();
    const dialog = page.getByRole('dialog');
    await expectLiveVideo(dialog);
    await button(dialog, 'Hủy chụp').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('1/5')).toBeVisible();

    for (let n = 2; n <= 5; n += 1) {
      await addAngle(page);
      await expect(page.getByText(`${n}/5`)).toBeVisible();
    }
    // the cap holds: no more angle button
    await expect(button(page, 'Thêm ảnh góc khác')).toHaveCount(0);
    await expect(page.getByText('5/5')).toBeVisible();
  });

  test('keypad digits, 000 and delete; name field; save stays disabled until a price', async ({
    page,
  }) => {
    await openEnrollFromUnknown(page);
    await expect(price(page)).toHaveText('0đ');
    await expect(save(page)).toBeDisabled();
    // nine digits at most: the tenth key press is ignored
    for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
      await button(page, digit).click();
    }
    await expect(price(page)).toHaveText('123.456.789đ');
    for (let i = 0; i < 9; i += 1) await button(page, 'Xóa').click();
    await expect(price(page)).toHaveText('0đ');
    await expect(save(page)).toBeDisabled();

    await keypad(page, ['1', '2', '000']);
    await expect(price(page)).toHaveText('12.000đ');
    await expect(save(page)).toBeEnabled();
    await button(page, 'Xóa').click();
    await expect(price(page)).toHaveText('1.200đ');
    for (let i = 0; i < 4; i += 1) await button(page, 'Xóa').click();
    await expect(price(page)).toHaveText('0đ');
    await expect(save(page)).toBeDisabled();

    const name = page.getByRole('textbox', { name: 'Tên (không bắt buộc)' });
    await name.fill('Kẹo dừa');
    await expect(name).toHaveValue('Kẹo dừa');
  });

  test('save: product lands in the cart and in inventory search', async ({
    page,
  }) => {
    await openEnrollFromUnknown(page);
    await addAngle(page);
    await page
      .getByRole('textbox', { name: 'Tên (không bắt buộc)' })
      .fill('Kẹo dừa');
    await keypad(page, ['1', '5', '000']);
    await expect(price(page)).toHaveText('15.000đ');
    await save(page).click();

    await expect(page).not.toHaveURL(/\/enroll/);
    await expect(cartPill(page)).toHaveAccessibleName(
      'Giỏ hàng: 1 món, 15.000đ',
    );

    await button(page, 'Vuốt lên: cửa hàng').click();
    await expect(page.getByRole('heading', { name: 'Kho' })).toBeVisible();
    await button(page, 'Tìm').click();
    await page.getByRole('textbox', { name: 'Tìm sản phẩm' }).fill('Kẹo dừa');
    await expect(button(page, /^Kẹo dừa, 15\.000đ/)).toBeVisible();
    await expect(page.getByRole('button', { name: /lon 330ml/ })).toHaveCount(
      0,
    );
  });

  test('empty enroll: capture an angle, price it, save without a name', async ({
    page,
  }) => {
    await openCamera(page);
    await button(page, 'Thêm vào kho với giá').click();
    await expect(page.getByText('0/5')).toBeVisible();
    await expect(save(page)).toBeDisabled();
    await addAngle(page);
    await expect(page.getByText('1/5')).toBeVisible();
    await expect(save(page)).toBeDisabled();
    await keypad(page, ['7', '000']);
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(page).not.toHaveURL(/\/enroll/);
    await expect(cartPill(page)).toHaveAccessibleName(
      'Giỏ hàng: 1 món, 7.000đ',
    );
  });
});
