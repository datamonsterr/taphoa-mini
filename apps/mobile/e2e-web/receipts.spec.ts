import { API_URL, button, callApi, expect, test } from './fixtures';

// This suite uses the real API, as do the other web specs. Older deployed backends
// may not have the receipts routes yet; all other response errors fail the test.
test.beforeEach(async ({ request, store }) => {
  const response = await request.get(`${API_URL}/v1/receipts`, {
    headers: { authorization: `Bearer ${store.api.token}` },
  });
  test.skip(
    response.status() === 404 ||
      response.status() === 405 ||
      response.status() === 501,
    'Backend lacks /v1/receipts',
  );
  expect(response.ok(), `Receipt preflight returned ${response.status()}`).toBe(
    true,
  );
});

test('Expense opens receipt history and shows the real empty list', async ({
  page,
}) => {
  await page.goto('/expense');
  const history = await callApi(page, 'GET', '/v1/receipts', () =>
    button(page, 'Hóa đơn nhập').click(),
  );
  expect(history.body.items).toEqual([]);
  await expect(page).toHaveURL(/\/receipts$/);
  await expect(page.getByText('Chưa có hóa đơn nhập')).toBeVisible();
});
