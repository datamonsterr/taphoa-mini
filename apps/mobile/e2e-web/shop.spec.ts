import {
  button,
  expect,
  goShop,
  keypad,
  openShop,
  shutter,
  test,
  expectLiveVideo,
} from './fixtures';

const tile = (page: Parameters<typeof button>[0], name: RegExp | string) =>
  page.getByRole('button', { name });
const searchBox = (page: Parameters<typeof button>[0]) =>
  page.getByRole('textbox', { name: 'Tìm sản phẩm' });

test.describe('shop tab bar', () => {
  test('tabs switch between Kho, Báo cáo and Tài khoản', async ({ page }) => {
    await openShop(page, '/inventory');
    await expect(page.getByRole('heading', { name: 'Kho' })).toBeVisible();
    await goShop(page, 'Báo cáo');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Báo cáo' })).toBeVisible();
    await goShop(page, 'Tài khoản');
    await expect(page).toHaveURL(/\/account/);
    await expect(
      page.getByRole('heading', { name: 'Tạp hóa Cô Ba' }),
    ).toBeVisible();
    await goShop(page, 'Kho');
    await expect(page).toHaveURL(/\/inventory/);
    await expect(page.getByRole('heading', { name: 'Kho' })).toBeVisible();
  });

  test('camera FAB opens the live camera on every tab', async ({ page }) => {
    for (const path of ['/inventory', '/dashboard', '/account'] as const) {
      await openShop(page, path);
      await button(page, 'Mở camera').click();
      await expect(shutter(page)).toBeEnabled();
      await expectLiveVideo(page);
    }
  });

  test('swipe-down handle returns to the camera', async ({ page }) => {
    await openShop(page, '/inventory');
    await button(page, 'Vuốt xuống: camera').click();
    await expect(shutter(page)).toBeVisible();
  });
});

test.describe('inventory', () => {
  test('lists the stock with low-stock badges', async ({ page }) => {
    await openShop(page, '/inventory');
    await expect(
      tile(page, /^Coca-Cola lon 330ml, 10\.000đ, còn 48$/),
    ).toBeVisible();
    await expect(
      tile(page, /^7Up lon 330ml, 9\.000đ, sắp hết: còn 3$/),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /, (còn|sắp hết)/ }),
    ).toHaveCount(12);
  });

  test('search filters the grid and clear restores it', async ({ page }) => {
    await openShop(page, '/inventory');
    await expect(searchBox(page)).toHaveCount(0);
    await button(page, 'Tìm').click();
    await searchBox(page).fill('Coca');
    await expect(tile(page, /^Coca-Cola/)).toBeVisible();
    await expect(tile(page, /^7Up/)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /, (còn|sắp hết)/ }),
    ).toHaveCount(1);

    await searchBox(page).fill('zzzz');
    await expect(page.getByText('Không tìm thấy sản phẩm')).toBeVisible();

    await button(page, 'Đóng tìm kiếm').click();
    await expect(searchBox(page)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /, (còn|sắp hết)/ }),
    ).toHaveCount(12);
    await expect(button(page, 'Tìm')).toBeVisible();
  });

  test('low-stock filter from the dashboard pill, then clear it', async ({
    page,
  }) => {
    await openShop(page, '/dashboard');
    await page.getByRole('button', { name: /món sắp hết$/ }).click();
    await expect(page).toHaveURL(/\/inventory\?filter=low/);
    await expect(
      page.getByRole('button', { name: /sắp hết: còn/ }),
    ).toHaveCount(3);
    await expect(page.getByRole('button', { name: /, còn \d+$/ })).toHaveCount(
      0,
    );
    await button(page, 'Bỏ lọc sắp hết hàng').click();
    await expect(
      page.getByRole('button', { name: /, (còn|sắp hết)/ }),
    ).toHaveCount(12);
    await expect(button(page, 'Bỏ lọc sắp hết hàng')).toHaveCount(0);
  });
});

test.describe('product', () => {
  test('detail shows the product, carousel dots follow a swipe, back returns', async ({
    page,
  }) => {
    await openShop(page, '/inventory');
    await tile(page, /^Coca-Cola lon 330ml, 10\.000đ/).click();
    await expect(page).toHaveURL(/\/product\//);
    await expect(
      page.getByRole('heading', { name: 'Coca-Cola lon 330ml' }),
    ).toBeVisible();
    await expect(page.getByLabel('Tồn kho 48')).toBeVisible();
    await expect(page.getByLabel('Giá nhập 7.500đ')).toBeVisible();
    await expect(page.getByLabel('Ảnh 1 trên 2')).toBeVisible();

    const carousel = page.getByTestId('product-carousel');
    await carousel.evaluate((el) => {
      (el as HTMLElement).scrollLeft = (el as HTMLElement).scrollWidth;
    });
    await expect(page.getByLabel('Ảnh 2 trên 2')).toBeVisible();
    await carousel.evaluate((el) => {
      (el as HTMLElement).scrollLeft = 0;
    });
    await expect(page.getByLabel('Ảnh 1 trên 2')).toBeVisible();

    await button(page, 'Quay lại').click();
    await expect(page).toHaveURL(/\/inventory/);
    await expect(page.getByRole('heading', { name: 'Kho' })).toBeVisible();
  });

  test('single-photo product has no dots', async ({ page }) => {
    await openShop(page, '/inventory');
    await tile(page, /^Pepsi lon 330ml/).click();
    await expect(
      page.getByRole('heading', { name: 'Pepsi lon 330ml' }),
    ).toBeVisible();
    await expect(page.getByLabel(/^Ảnh \d trên/)).toHaveCount(0);
  });

  test('edit price sheet: keypad, save updates detail and grid', async ({
    page,
  }) => {
    await openShop(page, '/inventory');
    await tile(page, /^Coca-Cola lon 330ml, 10\.000đ/).click();
    await button(page, 'Sửa giá').click();
    await expect(button(page, 'Lưu giá')).toBeVisible();
    for (let i = 0; i < 5; i += 1) await button(page, 'Xóa').click();
    await keypad(page, ['1', '2', '000']);
    await button(page, 'Lưu giá').click();
    await expect(button(page, 'Lưu giá')).toHaveCount(0);
    const visible = (text: string) =>
      page.getByText(text, { exact: true }).filter({ visible: true });
    await expect(visible('12.000đ')).toHaveCount(1);
    await expect(visible('10.000đ')).toHaveCount(0);

    await button(page, 'Quay lại').click();
    await expect(
      tile(page, /^Coca-Cola lon 330ml, 12\.000đ, còn 48$/),
    ).toBeVisible();
  });

  test('alerts product opens from the dashboard and goes back', async ({
    page,
  }) => {
    await openShop(page, '/dashboard');
    await page
      .getByRole('button', { name: /món giá bán dưới giá nhập$/ })
      .click();
    await button(page, 'Pepsi lon 330ml').click();
    await expect(
      page.getByRole('heading', { name: 'Pepsi lon 330ml' }),
    ).toBeVisible();
    await button(page, 'Quay lại').click();
    await expect(page.getByRole('heading', { name: 'Báo cáo' })).toBeVisible();
  });
});
