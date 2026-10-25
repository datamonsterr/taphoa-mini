import path from 'node:path';

import {
  API_URL,
  ApiError,
  button,
  callApi,
  createStoreViaApi,
  expect,
  hydrate,
  openShop,
  test,
  uuid7,
  type Api,
} from './fixtures';

/**
 * Assistant chat against the real backend running the scripted model (X3,
 * ASSISTANT_MODEL_PROVIDER=scripted, which scripts/e2e/stack.sh sets in CI): a deterministic
 * model, so the replies below are exact. The specs only observe API calls; nothing is faked.
 *
 * Skipped with a reason while the backend has no assistant routes (X3 not deployed) or runs a real
 * model (a Railway stack): the real-model smoke test is assistant-real.spec.ts.
 */

const GREETING = 'Xin chào! Mình là trợ lý của cửa hàng.';
const RECEIPT_REPLY =
  'Mình đã đọc hóa đơn. Bạn kiểm tra các dòng rồi bấm Xác nhận nhé.';

/** The recognition fixture the receipt specs of the backend use; its lines are listed below. */
const RECEIPT_PHOTO = path.join(
  __dirname,
  '../../backend/crates/recognition/tests/fixtures/receipts/receipt-1.jpg',
);
const RECEIPT_PRODUCTS = [
  { name: 'Coca-Cola lon 330ml', price: 10_000 },
  { name: 'Mì Hảo Hảo tôm chua cay', price: 5_000 },
  { name: 'Nước suối Aquafina 500ml', price: 6_000 },
  { name: 'Bánh Chocopie hộp', price: 15_000 },
];

const input = (page: import('@playwright/test').Page) =>
  page.getByTestId('assistant-input');
const send = (page: import('@playwright/test').Page) =>
  page.getByTestId('assistant-send');
const actionCard = (page: import('@playwright/test').Page) =>
  page.getByTestId('action-card');

/**
 * The `model` of the assistant's reply on a throwaway store, read once per worker: the model that
 * answers, as the backend reports it. `null` when the reply has none.
 */
let modelProbe: Promise<string | null> | undefined;
function probeModel(): Promise<string | null> {
  modelProbe ??= (async () => {
    const { api } = await createStoreViaApi();
    const thread = await api.post('/v1/assistant/threads', {
      context: { screen: 'chat' },
    });
    const response = await fetch(
      `${API_URL}/v1/assistant/threads/${thread.id}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${api.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: 'Xin chào', language: 'vi' }),
      },
    );
    await response.text(); // the stream ends with message.completed or error
    const detail = await api.get(`/v1/assistant/threads/${thread.id}`);
    const reply = detail.messages
      .filter((m: { role: string }) => m.role === 'assistant')
      .at(-1);
    return reply?.model ?? null;
  })();
  return modelProbe;
}

test.beforeEach(async ({ request, store }) => {
  const response = await request.get(`${API_URL}/v1/assistant/threads`, {
    headers: { authorization: `Bearer ${store.api.token}` },
  });
  test.skip(
    [404, 405, 501].includes(response.status()),
    'Backend lacks /v1/assistant/* (X3 not deployed)',
  );
  expect(
    response.ok(),
    `Assistant preflight returned ${response.status()}`,
  ).toBe(true);
  const model = await probeModel();
  test.skip(
    model !== 'scripted',
    `Backend answers with model ${JSON.stringify(model)}, not the scripted model`,
  );
});

/** Shop tab bar -> chat button -> the assistant sheet. */
async function openChat(page: import('@playwright/test').Page) {
  await openShop(page, '/inventory');
  await button(page, 'Mở trợ lý').click();
  await hydrate(page, page.getByTestId('assistant-screen'));
  await expect(input(page)).toBeVisible();
}

async function ask(page: import('@playwright/test').Page, text: string) {
  await input(page).fill(text);
  await expect(send(page)).toBeEnabled();
  await send(page).click();
}

/** A tracked product with `count` on hand (an adjustment by count starts tracking). */
async function seedTracked(api: Api, count: number) {
  const product = await api.createProduct({
    name: 'Coca-Cola lon 330ml',
    price: 10_000,
    cost_price: 7_500,
  });
  await api.post(
    `/v1/products/${product.id}/stock-adjustments`,
    { count },
    { 'Idempotency-Key': uuid7() },
  );
  expect((await api.get(`/v1/products/${product.id}`)).stock_quantity).toBe(
    count,
  );
  return product;
}

test('chat from the tab bar: a greeting streams back and the thread is listed', async ({
  page,
  store,
}) => {
  await openChat(page);
  await expect(page.getByTestId('assistant-empty')).toBeVisible();

  const created = await callApi(
    page,
    'POST',
    '/v1/assistant/threads',
    () => ask(page, 'Xin chào'),
    201,
  );
  expect(created.requestBody).toMatchObject({
    context: { screen: 'inventory' },
  });

  const messages = page.getByTestId('assistant-message');
  await expect(messages.getByText(GREETING)).toBeVisible();
  // done state: the thumbs show once the stream completed
  await expect(page.getByTestId('feedback-up')).toBeVisible();
  await expect(page.getByTestId(/^tool-line-/)).toHaveCount(0);
  await expect(send(page)).toBeDisabled(); // the field is empty again

  const detail = await store.api.get(
    `/v1/assistant/threads/${created.body.id}`,
  );
  expect(detail.messages.map((m: { role: string }) => m.role)).toEqual([
    'user',
    'assistant',
  ]);
  expect(detail.messages[1]).toMatchObject({
    content: GREETING,
    model: 'scripted',
  });

  // the thread list shows the thread
  await page.getByTestId('assistant-threads').click();
  const list = page.getByTestId('assistant-thread-list');
  await expect(list).toBeVisible();
  const { items } = await store.api.get('/v1/assistant/threads');
  expect(items).toHaveLength(1);
  await expect(
    list.getByRole('button', { name: items[0].title ?? 'Cuộc trò chuyện' }),
  ).toBeVisible();
  await expect(
    list.getByRole('button', { name: 'Xóa cuộc trò chuyện' }),
  ).toHaveCount(1);
});

test('stock adjustment: tool line, action card, confirm changes the stock once', async ({
  page,
  store,
}) => {
  const product = await seedTracked(store.api, 5);
  await openChat(page);
  await ask(page, 'Điều chỉnh tồn kho');

  // the get_stock_levels tool line ends in its ok state, then the proposal shows
  await expect(page.getByTestId(/^tool-line-.*-ok$/)).toBeVisible();
  const card = actionCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByText('Chờ xác nhận')).toBeVisible();
  // proposing never writes
  expect(
    (await store.api.get(`/v1/products/${product.id}`)).stock_quantity,
  ).toBe(5);

  const confirmed = await callApi(
    page,
    'POST',
    /^\/v1\/assistant\/actions\/[^/]+\/confirm$/,
    () => button(card, 'Xác nhận').click(),
  );
  expect(confirmed.body).toMatchObject({
    kind: 'stock_adjustment',
    status: 'done',
  });
  // the action id is the idempotency key
  expect(confirmed.requestHeaders['idempotency-key']).toBe(confirmed.body.id);
  await expect(card.getByText('Đã thực hiện')).toBeVisible();
  await expect(button(card, 'Xác nhận')).toHaveCount(0);

  const after = await store.api.get(`/v1/products/${product.id}`);
  expect(after.stock_quantity).toBe(6);

  // a retried confirm replays the first result and does not adjust again
  const route = `/v1/assistant/actions/${confirmed.body.id}/confirm`;
  const replay = await store.api.post(route, undefined, {
    'Idempotency-Key': confirmed.body.id,
  });
  expect(replay).toMatchObject({ id: confirmed.body.id, status: 'done' });
  // another key meets a decided action
  const decided = await store.api
    .post(route, undefined, { 'Idempotency-Key': uuid7() })
    .then(
      () => 200,
      (error: unknown) => (error instanceof ApiError ? error.status : -1),
    );
  expect(decided, 'a new key on a decided action').toBe(409);
  expect(
    (await store.api.get(`/v1/products/${product.id}`)).stock_quantity,
  ).toBe(6);
});

test('receipt chat: lines card, table view and back, confirm imports the receipt', async ({
  page,
  store,
}) => {
  for (const product of RECEIPT_PRODUCTS) {
    await store.api.createProduct({
      ...product,
      cost_price: product.price / 2,
    });
  }
  const imageId = await store.api.uploadImage(RECEIPT_PHOTO, 'receipt');
  let receipt;
  try {
    receipt = await store.api.post(
      '/v1/receipts',
      { image_id: imageId },
      { 'Idempotency-Key': uuid7() },
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 503 || error.status === 422 || error.status === 404)
    )
      test.skip(
        true,
        `Receipt OCR is unavailable in this stack: ${error.message}`,
      );
    throw error;
  }
  test.skip(
    receipt.lines.some((l: { product_id: string | null }) => !l.product_id),
    'The stack OCR did not map every fixture line to a seeded product, so confirm would 422',
  );

  await page.goto(
    `/assistant?entry=receipt&screen=camera&receiptId=${receipt.id}`,
  );
  await hydrate(page, page.getByTestId('assistant-screen'));

  await expect(page.getByText(RECEIPT_REPLY)).toBeVisible();
  const card = page.getByTestId('card-receipt-lines');
  await expect(card).toBeVisible();
  for (const line of receipt.lines)
    await expect(
      page.getByTestId(`receipt-line-${line.id}-confidence`),
    ).toBeVisible();

  // the table view opens the receipt screen; back returns to the same chat
  await button(card, 'Xem dạng bảng').click();
  await expect(page).toHaveURL(new RegExp(`/receipt/${receipt.id}$`));
  await button(page, 'Quay lại').click();
  await hydrate(page, page.getByTestId('assistant-screen'));
  await expect(card).toBeVisible();

  const action = actionCard(page);
  await expect(action).toBeVisible();
  const confirmed = await callApi(
    page,
    'POST',
    /^\/v1\/assistant\/actions\/[^/]+\/confirm$/,
    () => button(action, 'Xác nhận').click(),
  );
  expect(confirmed.body).toMatchObject({
    kind: 'receipt_confirm',
    status: 'done',
  });
  await expect(action.getByText('Đã thực hiện')).toBeVisible();

  const after = await store.api.get(`/v1/receipts/${receipt.id}`);
  expect(after.status).toBe('confirmed');
  expect(after.expense_id).toBeTruthy();
});
