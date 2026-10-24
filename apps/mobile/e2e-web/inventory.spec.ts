import type { Page } from '@playwright/test';
import {
  button,
  callApi,
  expect,
  formatVnd,
  goShop,
  keypad,
  openShop,
  openShopLoading,
  test,
  waitForApi,
  type Api,
} from './fixtures';

type Product = {
  id: string;
  name: string | null;
  price: number;
  cost_price?: number | null;
};

/** The accessible name of a grid tile, as the app words it. */
function tileName(p: Product) {
  return `${p.name}, ${formatVnd(p.price)}`;
}

/** Three products; a purchase expense sets their cost price. */
async function seedCatalog(api: Api) {
  const coca = await api.createProduct({
    name: 'Coca-Cola lon 330ml',
    price: 10_000,
    cost_price: 7_500,
  });
  const pepsi = await api.createProduct({
    name: 'Pepsi lon 330ml',
    price: 9_000,
    cost_price: 7_000,
  });
  const mam = await api.createProduct({
    name: 'Nước mắm Nam Ngư 500ml',
    price: 35_000,
    cost_price: 30_000,
  });
  await api.createExpense({
    amount: 48 * 7_500 + 3 * 7_000 + 20 * 30_000,
    category: 'nhap_hang',
    purchase_lines: [
      { product_id: coca.id, quantity: 48, unit_cost: 7_500 },
      { product_id: pepsi.id, quantity: 3, unit_cost: 7_000 },
      { product_id: mam.id, quantity: 20, unit_cost: 30_000 },
    ],
  });
  return { coca, pepsi, mam };
}

const grid = (page: Page) =>
  page.getByRole('button', { name: /^.+, \d[\d.]*đ(, .+)?$/ });
const searchBox = (page: Page) =>
  page.getByRole('textbox', { name: 'Tìm sản phẩm' });

test.describe('inventory', () => {
  test('lists what GET /v1/products returned', async ({ page, store }) => {
    const { coca, pepsi, mam } = await seedCatalog(store.api);
    const list = await openShopLoading(
      page,
      '/inventory',
      'GET',
      '/v1/products',
    );
    expect(list.status).toBe(200);
    const items: Product[] = list.body.items;
    expect(items.map((p) => p.id).sort()).toEqual(
      [coca.id, pepsi.id, mam.id].sort(),
    );
    await expect(page.getByRole('heading', { name: 'Kho' })).toBeVisible();
    for (const item of items)
      await expect(button(page, tileName(item))).toBeVisible();
    await expect(grid(page)).toHaveCount(items.length);
  });

  test('an empty store says so', async ({ page }) => {
    const list = await openShopLoading(
      page,
      '/inventory',
      'GET',
      '/v1/products',
    );
    expect(list.body.items).toEqual([]);
    await expect(page.getByText('Chưa có sản phẩm')).toBeVisible();
  });

  test('search sends q to the server; the grid is its answer; clear restores it', async ({
    page,
    store,
  }) => {
    await seedCatalog(store.api);
    await openShop(page, '/inventory');
    await expect(grid(page)).toHaveCount(3);
    await button(page, 'Tìm').click();

    const found = await callApi(page, 'GET', '/v1/products', () =>
      searchBox(page).fill('Coca'),
    );
    expect(found.body.items.map((p: Product) => p.name)).toEqual([
      'Coca-Cola lon 330ml',
    ]);
    await expect(grid(page)).toHaveCount(1);
    await expect(button(page, /^Coca-Cola lon 330ml/)).toBeVisible();

    const none = await callApi(page, 'GET', '/v1/products', () =>
      searchBox(page).fill('zzzz'),
    );
    expect(none.body.items).toEqual([]);
    await expect(page.getByText('Không tìm thấy sản phẩm')).toBeVisible();

    await button(page, 'Đóng tìm kiếm').click();
    await expect(searchBox(page)).toHaveCount(0);
    await expect(grid(page)).toHaveCount(3);
  });

  test('tabs switch between Kho, Báo cáo and Tài khoản', async ({
    page,
    store,
  }) => {
    await openShop(page, '/inventory');
    const [report] = await Promise.all([
      waitForApi(page, 'GET', '/v1/reports/today'),
      goShop(page, 'Báo cáo'),
    ]);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Báo cáo' })).toBeVisible();
    expect(report.status).toBe(200);
    const [info] = await Promise.all([
      waitForApi(page, 'GET', '/v1/store'),
      goShop(page, 'Tài khoản'),
    ]);
    await expect(page).toHaveURL(/\/account/);
    await expect(
      page.getByRole('heading', { name: info.body.name }),
    ).toBeVisible();
    expect(info.body.id).toBe(store.session.store.id);
    await goShop(page, 'Kho');
    await expect(page).toHaveURL(/\/inventory/);
  });
});

test.describe('product', () => {
  test('detail shows the product the server returns; back returns to the grid', async ({
    page,
    store,
  }) => {
    const { coca } = await seedCatalog(store.api);
    await openShop(page, '/inventory');
    const detail = await callApi(page, 'GET', `/v1/products/${coca.id}`, () =>
      button(page, /^Coca-Cola lon 330ml, /).click(),
    );
    await expect(page).toHaveURL(/\/product\//);
    expect(detail.body).toMatchObject({
      id: coca.id,
      name: 'Coca-Cola lon 330ml',
      price: 10_000,
      cost_price: 7_500,
    });
    await expect(
      page.getByRole('heading', { name: detail.body.name }),
    ).toBeVisible();
    await expect(
      page.getByLabel(`Giá nhập ${formatVnd(detail.body.cost_price)}`),
    ).toBeVisible();
    await expect(
      page
        .getByText(formatVnd(detail.body.price), { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    // one enrollment photo: no carousel dots
    expect(detail.body.images).toHaveLength(1);
    await expect(page.getByLabel(/^Ảnh \d trên/)).toHaveCount(0);

    await button(page, 'Quay lại').click();
    await expect(page).toHaveURL(/\/inventory/);
    await expect(page.getByRole('heading', { name: 'Kho' })).toBeVisible();
  });

  test('edit price: PATCH answers with the new price, detail and grid show it, the history records it', async ({
    page,
    store,
  }) => {
    const { coca } = await seedCatalog(store.api);
    await openShop(page, '/inventory');
    await button(page, /^Coca-Cola lon 330ml, /).click();
    await button(page, 'Sửa giá').click();
    await expect(button(page, 'Lưu giá')).toBeVisible();
    for (let i = 0; i < 5; i += 1) await button(page, 'Xóa').click();
    await keypad(page, ['1', '2', '000']);

    const patch = await callApi(page, 'PATCH', `/v1/products/${coca.id}`, () =>
      button(page, 'Lưu giá').click(),
    );
    expect(patch.requestBody).toMatchObject({ price: 12_000 });
    expect(patch.body).toMatchObject({ id: coca.id, price: 12_000 });
    await expect(button(page, 'Lưu giá')).toHaveCount(0);
    const shown = (text: string) =>
      page.getByText(text, { exact: true }).filter({ visible: true });
    await expectPriceShown(shown, patch.body.price);
    await expect(shown(formatVnd(10_000))).toHaveCount(0);

    await button(page, 'Quay lại').click();
    await expect(button(page, tileName(patch.body))).toBeVisible();

    // the server kept the change, with the old value, in the price history
    const history = await store.api.get(
      `/v1/products/${coca.id}/price-history`,
    );
    expect(history.items[0]).toMatchObject({
      field: 'price',
      old_value: 10_000,
      new_value: 12_000,
    });
    const saved = await store.api.get(`/v1/products/${coca.id}`);
    expect(saved.price).toBe(12_000);
  });
});

async function expectPriceShown(
  shown: (text: string) => ReturnType<Page['getByText']>,
  price: number,
) {
  await expect(shown(formatVnd(price))).toHaveCount(1);
}
