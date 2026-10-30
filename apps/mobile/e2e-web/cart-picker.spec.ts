import type { Locator } from '@playwright/test';
import path from 'node:path';

import {
  button,
  cartPill,
  expect,
  openCamera,
  scanAndAdd,
  seedScannableProduct,
  test,
  uuid7,
} from './fixtures';

/**
 * Boards 06 (cart) and 07c (customer picker). The cart row keeps the full product name over up to
 * two lines and a package glyph while the photo loads; the picker has the chevron close, the
 * magnifier search, avatar rows with a red debt or a green settled chip, the count and the
 * "Khách mới" divider. The screenshots are the evidence for the design-gap issue.
 */

const COCA = { name: 'Coca-Cola lon 330ml', price: 10_000, cost_price: 7_500 };
const SHOTS = path.join(__dirname, 'screenshots');

/**
 * Waits until a sheet has stopped sliding in: the element is visible and its top edge is the same
 * in two reads 150 ms apart. Reanimated moves the sheet with a JS-driven transform on web, so
 * `getAnimations()` and Playwright's `animations: 'disabled'` do not see it.
 */
async function settled(locator: Locator) {
  await expect(locator).toBeVisible();
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const top = (await locator.boundingBox())?.y ?? Number.NaN;
        const same = top === last;
        last = top;
        return same;
      },
      { intervals: [150], timeout: 10_000 },
    )
    .toBe(true);
}

test('cart row and customer picker match boards 06 and 07c', async ({
  page,
  store,
}) => {
  test.setTimeout(120_000);
  const coca = await seedScannableProduct(store.api, COCA);
  await store.api.post('/v1/customers', {
    id: uuid7(),
    name: 'Chị Lan',
    phone: '0912345678',
  });
  await openCamera(page);
  await scanAndAdd(page, coca);
  await cartPill(page).click();

  // board 06: the whole name, the close chevron, the total and the QR pill
  const sheet = page.getByTestId('cart-sheet');
  await expect(sheet.getByText(COCA.name)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Đóng' })).toBeVisible();
  await settled(sheet);
  await page.screenshot({ path: path.join(SHOTS, 'cart-real.png') });

  await button(page, 'Hiện mã QR thanh toán').click();
  await page.getByRole('radio', { name: 'Ghi nợ' }).click();

  // board 07c
  await expect(
    page.getByRole('heading', { name: 'Chọn khách hàng' }),
  ).toBeVisible();
  await expect(page.getByPlaceholder('Tên hoặc số điện thoại')).toBeVisible();
  await expect(page.getByText('Khách gần đây')).toBeVisible();
  await expect(page.getByText('1 khách')).toBeVisible();
  await expect(page.getByText('Hết nợ', { exact: true })).toBeVisible();
  await expect(page.getByText('C', { exact: true })).toBeVisible();
  await expect(page.getByText('Khách mới')).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Tên khách hàng' }),
  ).toBeVisible();
  await settled(page.getByRole('heading', { name: 'Chọn khách hàng' }));
  await page.screenshot({ path: path.join(SHOTS, 'customerpick-real.png') });
});
