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
  withScanSlot,
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
          'x-store-id': String(api.session.store.id),
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
    headers: {
      authorization: `Bearer ${store.api.token}`,
      'x-store-id': String(store.api.session.store.id),
    },
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

/**
 * OCR shares the backend's one segmenter with scans and with the background indexing of products
 * that parallel specs just created: take the scan lock and retry while the answer is "busy".
 */
async function createReceipt(api: Api, imageId: string) {
  const key = uuid7();
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      return await withScanSlot(() =>
        api.post(
          '/v1/receipts',
          { image_id: imageId },
          { 'Idempotency-Key': key },
        ),
      );
    } catch (error) {
      const busy =
        error instanceof ApiError &&
        JSON.stringify(error.body).includes('segmenter busy');
      if (!busy || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

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

/**
 * Board 17 (docs/design/canvas/Assistant.dc.html) on the real screen at 390x844: sheet with a
 * grabber 56 px from the top, header (threads, title, new chat, collapse), lavender user bubble,
 * plain tool row, grey thumbs, one-line placeholder, grey send. The screenshot is the evidence
 * posted on the issue.
 */
test('chat looks like board 17: sheet, header, bubble, tool row, thumbs, composer', async ({
  page,
  store,
}) => {
  await seedTracked(store.api, 5);
  await openChat(page);
  const box = async (id: string) => {
    const found = await page.getByTestId(id).boundingBox();
    expect(found, id).not.toBeNull();
    return found!;
  };

  // The sheet starts 56 px down and shows a 40x5 grabber.
  expect((await box('assistant-panel')).y).toBe(56);
  const grabber = await box('assistant-grabber');
  expect([grabber.width, grabber.height]).toEqual([40, 5]);

  // Header, left to right: threads, "Trợ lý", new chat, collapse.
  const threads = await box('assistant-threads');
  const title = await page
    .getByRole('heading', { name: 'Trợ lý' })
    .boundingBox();
  const fresh = await box('assistant-new-chat');
  const close = await box('assistant-close');
  expect(threads.x).toBeLessThan(title!.x);
  expect(title!.x).toBeLessThan(fresh.x);
  expect(fresh.x).toBeLessThan(close.x);

  // Composer: a 56 px pill whose placeholder stays on one line, a grey 40% send.
  const field = await box('assistant-input');
  expect(field.height).toBe(56);
  await expect(page.getByTestId('assistant-input')).toHaveAttribute(
    'placeholder',
    'Hỏi trợ lý về cửa hàng…',
  );
  await expect(send(page)).toHaveCSS('background-color', 'rgb(17, 17, 20)');
  await expect(send(page)).toHaveCSS('opacity', '0.4');

  await ask(page, 'Điều chỉnh tồn kho');
  await expect(page.getByTestId('feedback-up')).toBeVisible();
  // user bubble: soft lavender with dark text
  const bubble = page.getByTestId('user-message').locator('div').first();
  await expect(bubble).toHaveCSS('background-color', 'rgb(238, 236, 253)');
  // tool row: no pill behind it
  const tool = page.getByTestId(/^tool-line-.*-ok$/).first();
  await expect(tool).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  // thumbs: 56 px grey circles
  const thumb = await box('feedback-up');
  expect([thumb.width, thumb.height]).toEqual([56, 56]);
  await expect(page.getByTestId('feedback-up')).toHaveCSS(
    'background-color',
    'rgb(243, 243, 245)',
  );
  await page.screenshot({
    path: path.join(__dirname, 'screenshots', 'assistant-board17-real.png'),
  });
});

/**
 * A refusal of the message request (here a 403 with English text) reads as a Vietnamese sentence
 * by status and offers Retry; the server's text is never shown.
 */
test('a refused message shows a Vietnamese notice, not the server text', async ({
  page,
}) => {
  await openChat(page);
  await page.route(/\/v1\/assistant\/threads\/[^/]+\/messages$/, (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'forbidden: store mismatch' }),
    }),
  );
  await ask(page, 'Xin chào');
  await expect(page.getByRole('alert')).toHaveText(
    'Bạn không có quyền làm việc này.',
  );
  await expect(page.getByText(/store mismatch/)).toHaveCount(0);
  await expect(page.getByTestId('assistant-retry')).toBeVisible();
});

/**
 * Board 17b (ChatVoice.dc.html) on the real screen: while the microphone is held the composer
 * shows the hint, level bars with a timer and the accent mic with its halo. Chromium has no
 * recognizer in CI, so a stand-in webkitSpeechRecognition fires `start` and `end`; the chat
 * button, its hold gesture and the composer are the real ones.
 */
test('holding the microphone looks like board 17b: hint, bars with timer, halo', async ({
  page,
}) => {
  await page.addInitScript(() => {
    class FakeRecognition extends EventTarget {
      lang = 'vi-VN';
      interimResults = false;
      maxAlternatives = 1;
      continuous = false;
      start() {
        setTimeout(() => this.dispatchEvent(new Event('start')), 0);
      }
      stop() {
        setTimeout(() => this.dispatchEvent(new Event('end')), 0);
      }
      abort() {
        this.stop();
      }
    }
    Object.assign(window, { webkitSpeechRecognition: FakeRecognition });
  });
  await openChat(page);
  const mic = page.getByTestId('voice-button');
  await expect(page.getByTestId('assistant-listening')).toHaveCount(0);
  await expect(page.getByTestId('voice-halo')).toHaveCount(0);

  // react-native-web reports a screen reader, so the mic toggles on a tap (hint: chạm để dừng)
  await mic.click();
  await expect(page.getByTestId('assistant-listening-hint')).toHaveText(
    'Đang nghe, chạm để dừng',
  );
  await expect(page.getByLabel('Ô nhập, đang nghe')).toBeVisible();
  // the timer reaches the board's 0:04
  await expect(page.getByTestId('assistant-listening-time')).toHaveText(
    '0:04',
    { timeout: 10_000 },
  );
  // a 56 px accent mic inside a 76 px soft halo
  const halo = (await page.getByTestId('voice-halo').boundingBox())!;
  expect([halo.width, halo.height]).toEqual([76, 76]);
  const held = (await mic.boundingBox())!;
  expect([held.width, held.height]).toEqual([56, 56]);
  await expect(mic).toHaveCSS('background-color', 'rgb(90, 67, 232)');
  await page.screenshot({
    path: path.join(__dirname, 'screenshots', 'assistant-board17b-real.png'),
  });

  await mic.click();
  await expect(page.getByTestId('assistant-listening')).toHaveCount(0);
  await expect(page.getByTestId('assistant-listening-hint')).toHaveCount(0);
  await expect(input(page)).toBeVisible();
});

test('stock adjustment: tool line, action card, confirm changes the stock once', async ({
  page,
  store,
}) => {
  const product = await seedTracked(store.api, 5);
  await openChat(page);
  await ask(page, 'Điều chỉnh tồn kho');

  // the scripted model calls get_stock_levels, then the propose tool: both lines end in ok
  // (their ids are the call ids rule_1 and rule_2), then the proposal shows
  await expect(page.getByTestId(/^tool-line-.*-ok$/)).toHaveCount(2);
  await expect(page.getByTestId(/^tool-line-.*-(running|failed)$/)).toHaveCount(
    0,
  );
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
  const imageId = await store.api.uploadImage(RECEIPT_PHOTO, 'expense_receipt');
  let receipt;
  try {
    receipt = await createReceipt(store.api, imageId);
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
