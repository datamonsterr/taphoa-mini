/* eslint-disable react-hooks/rules-of-hooks, no-empty-pattern -- Playwright fixtures use `use`. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signInPage } from './clerk-auth';
import {
  addButton,
  button,
  callApi,
  callInference,
  cartPill,
  expect,
  expectLiveVideo,
  saveProduct,
  test,
  typeAmount,
} from './fixtures';

// A real EAN-13 image, decoded by expo-camera's web detector from Chromium's fake webcam.
// Generate another clip with fixtures/make-video.sh fixtures/barcode.jpg <output.mjpeg>.
const CODE = '4006381333931';
const USED = '8931234567890';
test.use({
  signedIn: false,
  actionTimeout: 15_000,
  launchOptions: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'i89-barcode-'));
    const video = path.join(dir, 'barcode.mjpeg');
    const photo = readFileSync(path.join(__dirname, 'fixtures/barcode.jpg'));
    writeFileSync(
      video,
      Buffer.concat(Array.from({ length: 10 }, () => photo)),
    );
    try {
      await use({
        args: [
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
          `--use-file-for-fake-video-capture=${video}`,
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

test('unknown scan → enroll with duplicate correction → known scan → barcode sale; edit barcode', async ({
  page,
  store,
}, testInfo) => {
  test.setTimeout(180_000);
  // Seed a different photo so the 409 is the barcode unique index, not visual similarity.
  const existing = await store.api.createProduct({
    name: 'Mã đã dùng',
    price: 9000,
  });
  const seeded = await store.api.patch(`/v1/products/${existing.id}`, {
    barcode: USED,
  });
  expect(seeded.barcode).toBe(USED);
  const shots =
    process.env.I89_SHOTS_DIR ?? testInfo.outputPath('barcode-shots');
  mkdirSync(shots, { recursive: true });
  await signInPage(page, store.user.email);
  await expect(page).toHaveURL(/\/enroll/, { timeout: 30_000 });
  const field = page.getByRole('textbox', { name: 'Mã vạch (không bắt buộc)' });
  const typeBarcode = async (code: string) => {
    await field.click();
    await field.press('ControlOrMeta+A');
    await field.press('Backspace');
    if (code) await field.pressSequentially(code);
    await expect(field).toHaveValue(code);
    await field.blur();
  };
  await expect(field).toHaveValue(CODE);
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page
        .getByTestId('sheet-panel')
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42),
    )
    .toBe(0);
  await page.screenshot({ path: path.join(shots, 'enroll-barcode.png') });

  await button(page, 'Thêm ảnh góc khác').click();
  await expectLiveVideo(page.getByRole('dialog'));
  await button(page, 'Chụp').click();
  await expect(page.getByText('1/5')).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Tên (không bắt buộc)' })
    .fill('Hàng mã vạch');
  await typeBarcode(USED);
  await typeAmount(page, 12000);
  await expect(field).toHaveValue(USED);
  await callInference(
    page,
    'POST',
    '/v1/products',
    () => saveProduct(page).click(),
    409,
  );
  await expect(page.getByText('Mã vạch đã dùng cho Mã đã dùng')).toBeVisible();
  await page
    .getByText('Mã vạch đã dùng cho Mã đã dùng')
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'duplicate-barcode.png') });
  await typeBarcode(CODE);
  const created = await callInference(page, 'POST', '/v1/products', () =>
    saveProduct(page).click(),
  );
  expect(created.requestBody.barcode).toBe(CODE);
  await expect(page).not.toHaveURL(/\/enroll/);
  await expect(page.getByTestId('barcode-indicator')).toContainText(
    'Hàng mã vạch',
  );
  await page.screenshot({ path: path.join(shots, 'camera-barcode.png') });

  // Enrollment already added a line. Remove it, then prove checkout's separate barcode path.
  await cartPill(page).click();
  await button(page, 'Xóa').click();
  await button(page, 'Về máy ảnh').click();
  await expect(page.getByTestId('barcode-indicator')).toContainText('12.000đ');
  await addButton(page).click();
  await expect(cartPill(page)).toHaveAccessibleName('Giỏ hàng: 1 món, 12.000đ');
  await cartPill(page).click();
  await button(page, 'Hiện mã QR thanh toán').click();
  await page.getByRole('radio', { name: 'Tiền mặt' }).click();
  const sale = await callApi(page, 'POST', '/v1/sales', () =>
    button(page, 'Đã nhận tiền').click(),
  );
  expect(sale.requestBody.lines).toEqual([
    expect.objectContaining({
      product_id: created.body.id,
      source: 'barcode',
      quantity: 1,
    }),
  ]);

  await page.goto('/inventory');
  await button(page, 'Hàng mã vạch, 12.000đ').click();
  await button(page, 'Sửa giá').click();
  await expect(field).toHaveValue(CODE);
  await typeBarcode('');
  await button(page, 'Quét mã vạch').click();
  await expect(field).toHaveValue(CODE);
  await expect
    .poll(() =>
      page
        .getByTestId('sheet-panel')
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42),
    )
    .toBe(0);
  await page.screenshot({ path: path.join(shots, 'product-edit-barcode.png') });
  await typeBarcode('12345678');
  const patched = await callApi(
    page,
    'PATCH',
    `/v1/products/${created.body.id}`,
    () => button(page, 'Lưu giá').click(),
  );
  expect(patched.requestBody.barcode).toBe('12345678');
  await expect(page.getByText('Mã vạch · 12345678')).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'product-barcode.png') });
});
