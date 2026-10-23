import {
  addButton,
  button,
  cartPill,
  detectionBoxes,
  expect,
  openCamera,
  reshoot,
  shoot,
  shutter,
  test,
  vnd,
} from './fixtures';
import type { Page } from '@playwright/test';

const modeSingle = (page: Page) => button(page, 'Một món');
const modeMulti = (page: Page) => button(page, 'Nhiều món');
const pricePill = (page: Page) =>
  page.getByRole('button', { name: /xem món khác$/ });

/** Third single scan of a fresh mock is the unknown one. */
async function scanUnknown(page: Page) {
  await shoot(page);
  await reshoot(page).click();
  await shoot(page);
  await reshoot(page).click();
  await shutter(page).click();
  await expect(button(page, 'Chưa có trong kho, nhập giá')).toBeVisible();
}

test.describe('camera', () => {
  test('live preview shows the fake webcam, mode toggle, empty cart pill', async ({
    page,
  }) => {
    await openCamera(page);
    const video = page.locator('video');
    await expect(video).toBeVisible();
    await expect
      .poll(() =>
        video.evaluate(
          (v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth > 0,
        ),
      )
      .toBe(true);
    await expect(modeSingle(page)).toBeVisible();
    await expect(modeMulti(page)).toBeVisible();
    await expect(button(page, 'Giỏ hàng trống')).toBeVisible();
    await expect(addButton(page)).toBeDisabled();
    await expect(button(page, 'Thêm vào kho với giá')).toBeVisible();
    await expect(button(page, 'Vuốt lên: cửa hàng')).toBeVisible();
  });

  test('single: shutter freezes the photo with one box inside the viewfinder and a price pill', async ({
    page,
  }) => {
    await openCamera(page);
    await shoot(page);
    await expect(page.getByTestId('viewfinder-photo')).toBeVisible();
    await expect(detectionBoxes(page)).toHaveCount(1);
    await expect(pricePill(page)).toHaveCount(1);
    await expect(pricePill(page)).toContainText('10.000');
    await expect(page.getByTestId('box-badge')).toHaveCount(0);

    const finder = await page.getByTestId('viewfinder').boundingBox();
    const box = await detectionBoxes(page).boundingBox();
    expect(finder).not.toBeNull();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(finder!.x);
    expect(box!.y).toBeGreaterThanOrEqual(finder!.y);
    expect(box!.x + box!.width).toBeLessThanOrEqual(finder!.x + finder!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      finder!.y + finder!.height,
    );
    await expect(addButton(page)).toBeEnabled();
  });

  test('price pill opens the alternatives strip; a chip changes the price', async ({
    page,
  }) => {
    await openCamera(page);
    await shoot(page);
    const strip = page.getByRole('radiogroup', { name: 'Chọn đúng món' });
    await expect(strip).toHaveCount(0);
    await pricePill(page).click();
    await expect(strip).toBeVisible();
    const chips = strip.getByRole('radio');
    expect(await chips.count()).toBeGreaterThan(1);
    await expect(chips.first()).toBeChecked();
    await expect(chips.nth(1)).not.toBeChecked();
    const before = vnd((await pricePill(page).innerText()).split('\n')[0]!);
    const other = chips.nth(1);
    const otherLabel = (await other.getAttribute('aria-label'))!;
    const otherPrice = vnd(otherLabel);
    expect(otherPrice).not.toBe(before);
    await other.click();
    await expect(pricePill(page)).toHaveAccessibleName(
      `${otherLabel}, xem món khác`,
    );
    await expect(pricePill(page)).toContainText(
      otherPrice.toLocaleString('vi-VN'),
    );
    // the chosen product leads the strip and its box is renamed
    await expect(
      button(page, `${otherLabel.replace(/ [\d.]+đ$/, '')}, đã chọn`),
    ).toBeVisible();
  });

  test('+ adds the chosen item; cart pill count and total update; reshoot returns to live', async ({
    page,
  }) => {
    await openCamera(page);
    await shoot(page);
    await pricePill(page).click();
    const chip = page
      .getByRole('radiogroup', { name: 'Chọn đúng món' })
      .getByRole('radio')
      .nth(1);
    const chipLabel = (await chip.getAttribute('aria-label'))!;
    await chip.click();
    await addButton(page).click();
    await expect(shutter(page)).toBeVisible();
    await expect(cartPill(page)).toHaveAccessibleName(
      new RegExp(
        `^Giỏ hàng: 1 món, ${vnd(chipLabel).toLocaleString('vi-VN')}đ$`,
      ),
    );
    await expect(page.getByTestId('cart-count')).toHaveText('1');
    // a second add of a different item raises the total
    const totalBefore = vnd(
      (await cartPill(page).getAttribute('aria-label'))!.split(',')[1]!,
    );
    await shoot(page);
    await addButton(page).click();
    await expect(shutter(page)).toBeVisible();
    await expect
      .poll(async () =>
        vnd((await cartPill(page).getAttribute('aria-label'))!.split(',')[1]!),
      )
      .toBeGreaterThan(totalBefore);
    await expect(page.getByTestId('cart-count')).toHaveText('2');
  });

  test('retake returns to the live preview', async ({ page }) => {
    await openCamera(page);
    await shoot(page);
    await reshoot(page).click();
    await expect(shutter(page)).toBeEnabled();
    await expect(page.getByTestId('viewfinder-photo')).toHaveCount(0);
    await expect(page.locator('video')).toBeVisible();
    await expect(detectionBoxes(page)).toHaveCount(0);
    // tapping the frozen photo also goes back
    await shoot(page);
    await button(page, 'Quay lại máy ảnh').click({
      position: { x: 40, y: 20 },
    });
    await expect(shutter(page)).toBeVisible();
  });

  test('multi: three numbered boxes inside the viewfinder; deselect changes the + badge; add all', async ({
    page,
  }) => {
    await openCamera(page);
    await modeMulti(page).click();
    await shoot(page);
    await expect(detectionBoxes(page)).toHaveCount(3);
    await expect(page.getByTestId('box-badge')).toHaveText(['1', '2', '3']);
    await expect(
      page.getByRole('button', { name: /xem món khác$/ }),
    ).toHaveCount(3);

    const finder = (await page.getByTestId('viewfinder').boundingBox())!;
    for (const box of await detectionBoxes(page).all()) {
      const rect = (await box.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(finder.x);
      expect(rect.x + rect.width).toBeLessThanOrEqual(finder.x + finder.width);
      expect(rect.y).toBeGreaterThanOrEqual(finder.y);
      expect(rect.y + rect.height).toBeLessThanOrEqual(
        finder.y + finder.height,
      );
    }

    const add = button(page, 'Thêm tất cả vào giỏ');
    await expect(page.getByTestId('add-badge')).toHaveText('3');
    await detectionBoxes(page).nth(1).click();
    await expect(page.getByTestId('add-badge')).toHaveText('2');
    await expect(button(page, /bỏ chọn$/)).toHaveCount(1);
    await expect(page.getByTestId('box-badge')).toHaveCount(2);
    await detectionBoxes(page).nth(1).click();
    await expect(page.getByTestId('add-badge')).toHaveText('3');
    await detectionBoxes(page).nth(0).click();
    await detectionBoxes(page).nth(0).click();
    await expect(add).toBeVisible();
    await add.click();
    await expect(shutter(page)).toBeVisible();
    await expect(cartPill(page)).toHaveAccessibleName(/^Giỏ hàng: 3 món, /);
  });

  test('multi: deselected boxes are left out of the cart', async ({ page }) => {
    await openCamera(page);
    await modeMulti(page).click();
    await shoot(page);
    await detectionBoxes(page).nth(0).click();
    await addButton(page).click();
    await expect(shutter(page)).toBeVisible();
    await expect(cartPill(page)).toHaveAccessibleName(/^Giỏ hàng: 2 món, /);
  });

  test('mode toggle returns to single (one box again)', async ({ page }) => {
    await openCamera(page);
    await modeMulti(page).click();
    await modeSingle(page).click();
    await shoot(page);
    await expect(detectionBoxes(page)).toHaveCount(1);
  });

  test('unknown item: "?" pill, + disabled, tag and "?" open enroll', async ({
    page,
  }) => {
    await openCamera(page);
    await scanUnknown(page);
    await expect(page.getByTestId('viewfinder')).toBeVisible();
    await expect(button(page, 'Chưa có trong kho, nhập giá')).toContainText(
      '?',
    );
    await expect(detectionBoxes(page)).toHaveCount(1);
    await expect(button(page, /chưa có trong kho$/)).toBeVisible();
    await expect(addButton(page)).toBeDisabled();
    await expect(page.getByTestId('enroll-arrow')).toBeVisible();

    await button(page, 'Chưa có trong kho, nhập giá').click();
    await expect(page).toHaveURL(/\/enroll/);
    await expect(button(page, 'Lưu vào kho và thêm vào giỏ')).toBeVisible();
    await button(page, 'Đóng').click();
    await expect(shutter(page).or(reshoot(page))).toBeVisible();
  });

  test('unknown item: the tag button opens enroll with the photo', async ({
    page,
  }) => {
    await openCamera(page);
    await scanUnknown(page);
    await button(page, 'Thêm vào kho với giá').click();
    await expect(page).toHaveURL(/\/enroll\?.*photoUri=/);
    await expect(page.getByText('1/5')).toBeVisible();
  });

  test('tag button with no result opens an empty enroll', async ({ page }) => {
    await openCamera(page);
    await button(page, 'Thêm vào kho với giá').click();
    await expect(page).toHaveURL(/\/enroll$/);
    await expect(page.getByText('0/5')).toBeVisible();
  });

  test('swipe handle opens the inventory', async ({ page }) => {
    await openCamera(page);
    await button(page, 'Vuốt lên: cửa hàng').click();
    await expect(page).toHaveURL(/\/inventory/);
    await expect(page.getByRole('heading', { name: 'Kho' })).toBeVisible();
  });

  test('cart pill opens the cart', async ({ page }) => {
    await openCamera(page);
    await shoot(page);
    await addButton(page).click();
    await cartPill(page).click();
    await expect(page).toHaveURL(/\/cart/);
  });
});
