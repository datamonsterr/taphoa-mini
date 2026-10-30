import type { Page } from '@playwright/test';
import {
  addButton,
  button,
  cartPill,
  detectionBoxes,
  expect,
  expectLiveVideo,
  enrollTag,
  formatVnd,
  openCamera,
  pricePill,
  reshoot,
  scanAndAdd,
  seedScannableProduct,
  shoot,
  shutter,
  test,
} from './fixtures';

const modeSingle = (page: Page) => button(page, 'Một món');
const modeMulti = (page: Page) => button(page, 'Nhiều món');

test.describe('camera', () => {
  test('live preview shows the fake webcam, the mode toggle and an empty cart', async ({
    page,
  }) => {
    await openCamera(page);
    await expectLiveVideo(page);
    await expect(modeSingle(page)).toBeVisible();
    await expect(modeMulti(page)).toBeVisible();
    await expect(button(page, 'Giỏ hàng trống')).toBeVisible();
    await expect(addButton(page)).toBeDisabled();
    await expect(button(page, 'Thêm vào kho với giá')).toBeVisible();
    await expect(button(page, 'Vuốt lên: cửa hàng')).toBeVisible();
  });

  test('a matched item: the price pill is the server candidate; the strip lists the candidates', async ({
    page,
    store,
  }) => {
    const coca = await seedScannableProduct(store.api);
    await openCamera(page);
    const scan = await shoot(page);
    const detection = scan.body.detections[0];
    expect(detection.match).toBe('matched');
    expect(detection.candidates[0]).toMatchObject({
      product_id: coca.id,
      name: coca.name,
      price: coca.price,
    });
    await expect(page.getByTestId('viewfinder-photo')).toBeVisible();
    await expect(detectionBoxes(page)).toHaveCount(1);
    await expect(pricePill(page)).toHaveAccessibleName(
      `${coca.name} ${formatVnd(coca.price)}, xem món khác`,
    );
    await expect(addButton(page)).toBeEnabled();

    const strip = page.getByRole('radiogroup', { name: 'Chọn đúng món' });
    await expect(strip).toHaveCount(0);
    await pricePill(page).click();
    await expect(strip).toBeVisible();
    await expect(strip.getByRole('radio')).toHaveCount(
      detection.candidates.length,
    );
    await expect(strip.getByRole('radio').first()).toBeChecked();
  });

  test('retake returns to the live preview and a second shot is scanned again', async ({
    page,
  }) => {
    await openCamera(page);
    const first = await shoot(page);
    await reshoot(page).click();
    await expect(shutter(page)).toBeEnabled();
    await expect(page.getByTestId('viewfinder-photo')).toHaveCount(0);
    await expect(detectionBoxes(page)).toHaveCount(0);
    await expectLiveVideo(page);

    // the camera is usable again: a second shot is a second scan
    const again = await shoot(page);
    expect(again.body.id).not.toBe(first.body.id);
    await expect(page.getByTestId('viewfinder-photo')).toBeVisible();
  });

  test('+ adds the matched item: the cart pill count and total follow, the camera is live again', async ({
    page,
    store,
  }) => {
    const coca = await seedScannableProduct(store.api);
    await openCamera(page);
    await scanAndAdd(page, coca);
    await expect(cartPill(page)).toHaveAccessibleName(
      `Giỏ hàng: 1 món, ${formatVnd(coca.price)}`,
    );
    await expect(page.getByTestId('cart-count')).toHaveText('1');
    await expect(shutter(page)).toBeEnabled();
    await cartPill(page).click();
    await expect(page).toHaveURL(/\/cart/);
  });

  test('tag toggles purple quick mode and returns to checkout without navigating', async ({
    page,
  }) => {
    await openCamera(page);
    const tag = enrollTag(page);
    await expect(tag).toHaveAttribute('aria-selected', 'false');
    await tag.click();
    await expect(tag).toHaveAttribute('aria-selected', 'true');
    await expect(tag).toHaveCSS('background-color', 'rgb(90, 67, 232)');
    await expect(page.getByText('Xoay sản phẩm')).toBeVisible();
    await expect(page).not.toHaveURL(/\/enroll/);
    await tag.click();
    await expect(tag).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByText('Xoay sản phẩm')).toHaveCount(0);
    await expectLiveVideo(page);
  });

  test('swipe handle opens the stock', async ({ page }) => {
    await openCamera(page);
    await button(page, 'Vuốt lên: cửa hàng').click();
    await expect(page).toHaveURL(/\/inventory/);
    await expect(page.getByRole('heading', { name: 'Kho' })).toBeVisible();
    await button(page, 'Vuốt xuống: camera').click();
    await expect(shutter(page)).toBeVisible();
  });

  test('the camera button on every shop tab opens the live camera', async ({
    page,
  }) => {
    for (const path of ['/inventory', '/dashboard', '/account'] as const) {
      await page.goto(path);
      await expect(page.getByRole('tablist', { name: 'Chính' })).toBeVisible();
      await button(page, 'Mở camera').click();
      await expect(shutter(page)).toBeEnabled();
      await expectLiveVideo(page);
    }
  });
});
