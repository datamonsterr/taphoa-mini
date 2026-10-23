import {
  expect,
  test as base,
  type Locator,
  type Page,
} from '@playwright/test';

/** Every spec fails on an uncaught page error or a console.error. */
export const test = base.extend<{ consoleGuard: void }>({
  consoleGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on('pageerror', (error) =>
        problems.push(`pageerror: ${error.message}`),
      );
      page.on('requestfailed', (request) =>
        problems.push(
          `requestfailed: ${request.url().slice(0, 120)} ${request.failure()?.errorText}`,
        ),
      );
      page.on('console', (message) => {
        if (message.type() === 'error')
          problems.push(`console.error: ${message.text()}`);
      });
      await use();
      expect(problems, 'browser errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole('button', { name, exact: typeof name === 'string' });

/** Waits for fonts and the first screen landmark; never sleeps. */
export async function hydrate(page: Page, landmark: Locator) {
  await expect(landmark).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Opens the camera screen and waits for the live preview: the shutter enables once the camera is ready. */
export async function openCamera(page: Page) {
  await page.goto('/');
  await hydrate(page, button(page, 'Chụp'));
  await expect(button(page, 'Chụp')).toBeEnabled();
  await expect(page.locator('video')).toBeVisible();
}

export const shutter = (page: Page) => button(page, 'Chụp');
export const reshoot = (page: Page) => button(page, 'Chụp lại');
export const addButton = (page: Page) =>
  page.getByRole('button', { name: /^Thêm (vào|tất cả vào) giỏ$/ });
export const cartPill = (page: Page) =>
  page.getByRole('button', { name: /^Giỏ hàng/ });

/** Shoots and waits for the frozen result (the reshoot button replaces the shutter). */
export async function shoot(page: Page) {
  await shutter(page).click();
  await expect(reshoot(page)).toBeVisible();
  await expect(
    page
      .getByRole('button', { name: /, (đã chọn|bỏ chọn|chưa có trong kho)$/ })
      .first(),
  ).toBeVisible();
}

export const detectionBoxes = (page: Page) =>
  page.getByRole('button', { name: /, (đã chọn|bỏ chọn|chưa có trong kho)$/ });

/** Types a number on the keypad ("000" is one key). */
export async function keypad(scope: Page | Locator, keys: string[]) {
  for (const key of keys) await button(scope, key).click();
}

/** Last number in a text, dots read as thousands separators: "Coca 330ml 10.000đ" gives 10000. */
export const vnd = (text: string) => {
  const numbers = text.match(/\d[\d.]*/g) ?? [];
  return Number((numbers.at(-1) ?? '').replace(/\./g, ''));
};

export async function goShop(page: Page, tab: 'Kho' | 'Báo cáo' | 'Tài khoản') {
  await page.getByRole('tab', { name: tab, exact: true }).click();
}

/** First single scan of a fresh mock is Coca-Cola 10.000đ: shoot it, add it, then open the cart sheet. */
export async function addCocaAndOpenCart(page: Page) {
  await openCamera(page);
  await shoot(page);
  await addButton(page).click();
  await expect(cartPill(page)).toHaveAccessibleName('Giỏ hàng: 1 món, 10.000đ');
  await cartPill(page).click();
  await expect(page).toHaveURL(/\/cart/);
}

/** Waits until a <video> in the scope plays the fake webcam. */
export async function expectLiveVideo(scope: Page | Locator) {
  const video = scope.locator('video');
  await expect(video).toBeVisible();
  await expect
    .poll(() =>
      video.evaluate(
        (v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth > 0,
      ),
    )
    .toBe(true);
}

/** Camera screen -> third single scan is unknown -> tap the "?" pill: opens enroll with the cropped photo. */
export async function openEnrollFromUnknown(page: Page) {
  await openCamera(page);
  await shoot(page);
  await reshoot(page).click();
  await shoot(page);
  await reshoot(page).click();
  await shutter(page).click();
  await button(page, 'Chưa có trong kho, nhập giá').click();
  await expect(page).toHaveURL(/\/enroll/);
  await expect(button(page, 'Lưu vào kho và thêm vào giỏ')).toBeVisible();
}

/** Opens a shop route directly and waits for its landmark and the fonts. */
export async function openShop(
  page: Page,
  path: '/inventory' | '/dashboard' | '/account',
) {
  await page.goto(path);
  await hydrate(page, page.getByRole('tablist', { name: 'Chính' }));
  await expect(
    page.getByRole('tab', { name: 'Kho', exact: true }),
  ).toBeVisible();
}
