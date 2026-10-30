import { mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  API_URL,
  button,
  callApi,
  expect,
  hydrate,
  openShop,
  test,
  waitForApi,
  type Api,
} from './fixtures';

/**
 * The voice sale sheet against the real backend (V1 voice routes). The browser has no m4a recorder,
 * so the web build never records: the long-press opens the sheet on the on-device (Web Speech)
 * pane, and the fixture route `/voice?fixture=<clip>` uploads a fixture clip name instead of the
 * microphone (honoured because the E2E export sets EXPO_PUBLIC_VOICE_FIXTURES=1). The specs only
 * observe API calls; nothing is faked.
 *
 * The specs that need the voice routes skip with a reason while the backend lacks them (V1 not
 * deployed). The backend selects the reply of a fixture clip by its file name, like the mobile mock.
 */

const DIR = path.join(__dirname, 'screenshots');
mkdirSync(DIR, { recursive: true });

const CATALOG = [
  { name: 'Coca-Cola lon 330ml', price: 10_000 },
  { name: 'Pepsi lon 330ml', price: 9_000 },
];

type Page = import('@playwright/test').Page;

/** Skips the current spec when the backend has no voice routes (anything but 404/405/501). */
async function requireVoiceRoutes(
  request: import('@playwright/test').APIRequestContext,
  store: { api: Api },
) {
  const response = await request.post(`${API_URL}/v1/voice/utterances`, {
    headers: {
      authorization: `Bearer ${store.api.token}`,
      'x-store-id': String(store.api.session.store.id),
    },
    multipart: { mode: 'sale' },
  });
  test.skip(
    [404, 405, 501].includes(response.status()),
    'Backend lacks /v1/voice/* (V1 not deployed)',
  );
}

async function seedCatalog(store: { api: Api }) {
  for (const product of CATALOG) await store.api.createProduct(product);
}

/** Opens the sheet on a fixture clip: it records straight away, Xong sends the clip. */
async function openFixture(page: Page, clip: string) {
  await page.goto(`/voice?entry=longpress&fixture=${clip}`);
  await hydrate(page, page.getByTestId('voice-listening'));
}

const stop = (page: Page) => button(page, 'Xong, hiểu lời vừa nói');

test('long-pressing the chat button opens the voice sheet', async ({
  page,
}) => {
  await openShop(page, '/inventory');
  const chat = button(page, 'Mở trợ lý');
  await chat.click({ delay: 800 });
  // the web has no m4a recorder: the sheet starts on the on-device recognition pane
  const sheet = page.getByTestId('voice-fallback');
  await hydrate(page, sheet);
  await expect(sheet.getByText('Nói tên hàng và giá')).toBeVisible();
  await expect(page).toHaveURL(/\/voice\?entry=longpress/);
  await expect(page.getByTestId('assistant-screen')).toHaveCount(0);
  await page.screenshot({ path: path.join(DIR, 'voice-web-device-pane.png') });
  await button(page, 'Đóng').click();
  await expect(sheet).toHaveCount(0);
});

test('a tap on the chat button still opens the assistant', async ({ page }) => {
  await openShop(page, '/inventory');
  await button(page, 'Mở trợ lý').click();
  await hydrate(page, page.getByTestId('assistant-screen'));
  await expect(page.getByTestId('voice-fallback')).toHaveCount(0);
});

test('fixture clip: listening, draft with two lines, cash confirm records a voice sale', async ({
  page,
  request,
  store,
}) => {
  await requireVoiceRoutes(request, store);
  await seedCatalog(store);
  await openFixture(page, 'two-line-sale.m4a');
  await expect(page.getByText('Nói tên hàng và giá')).toBeVisible();
  await page.screenshot({ path: path.join(DIR, 'voice-web-1-listening.png') });

  const uploaded = await callApi(
    page,
    'POST',
    '/v1/voice/utterances',
    () => stop(page).click(),
    201,
  );
  expect(uploaded.body).toMatchObject({ mode: 'sale', intent: 'sale' });

  const draft = page.getByTestId('voice-draft');
  await expect(draft).toBeVisible();
  const lines = uploaded.body.sale_draft.lines as { quantity: number }[];
  expect(lines).toHaveLength(2);
  await expect(draft.getByTestId(/^voice-line-[0-9a-f-]{36}$/)).toHaveCount(2);
  await expect(page.getByTestId('voice-total')).toBeVisible();
  await page.screenshot({ path: path.join(DIR, 'voice-web-2-draft.png') });

  // nothing is written before the green check
  const before = await store.api.get('/v1/sales');
  expect(before.items).toHaveLength(0);

  const outcome = waitForApi(
    page,
    'POST',
    /\/v1\/voice\/utterances\/[^/]+\/outcome$/,
    204,
  );
  const sale = await callApi(
    page,
    'POST',
    '/v1/sales',
    () => button(page, 'Xác nhận bán').click(),
    201,
  );
  expect(sale.requestBody.payment_method).toBe('cash');
  expect(
    sale.requestBody.lines.every(
      (line: { source: string }) => line.source === 'voice',
    ),
  ).toBe(true);
  expect(sale.requestBody.lines.map((line: { id: string }) => line.id)).toEqual(
    uploaded.body.sale_draft.lines.map((line: { id: string }) => line.id),
  );
  await expect(page.getByText(/^Đã bán \d+ món · /)).toBeVisible();
  await page.screenshot({ path: path.join(DIR, 'voice-web-3-sold.png') });
  expect((await outcome).requestBody).toMatchObject({
    outcome: 'confirmed',
    sale_id: sale.body.id,
  });

  const after = await store.api.get('/v1/sales');
  expect(after.items).toHaveLength(1);
  expect(after.items[0].total).toBe(sale.requestBody.total);
  // the sheet closes by itself and leaves the shop where it was
  await expect(page.getByTestId('voice-draft')).toHaveCount(0);
});

/** #166 evidence: the credit draft shows board 16's customer card and the one-pill footer. */
test('fixture clip: a credit draft shows the customer card and the pill footer', async ({
  page,
  request,
  store,
}) => {
  await requireVoiceRoutes(request, store);
  await seedCatalog(store);
  await openFixture(page, 'credit-sale.m4a');
  await callApi(
    page,
    'POST',
    '/v1/voice/utterances',
    () => stop(page).click(),
    201,
  );
  await expect(page.getByTestId('voice-draft')).toBeVisible();
  await expect(page.getByTestId('voice-customer')).toBeVisible();
  await expect(page.getByTestId('voice-total')).toBeVisible();
  await page.screenshot({ path: path.join(DIR, 'voice-web-4-credit.png') });
});

test('a silent clip asks to say it again', async ({ page, request, store }) => {
  await requireVoiceRoutes(request, store);
  await openFixture(page, 'no-speech.m4a');
  await callApi(
    page,
    'POST',
    '/v1/voice/utterances',
    () => stop(page).click(),
    422,
  );
  await expect(page.getByText('Chưa nghe rõ, nói lại nhé')).toBeVisible();
  await expect(page.getByTestId('voice-retry')).toBeVisible();
});

test('a question opens the assistant with the words as the first message', async ({
  page,
  request,
  store,
}) => {
  await requireVoiceRoutes(request, store);
  await openFixture(page, 'chat-intent.m4a');
  await callApi(
    page,
    'POST',
    '/v1/voice/utterances',
    () => stop(page).click(),
    201,
  );
  await page.getByTestId('voice-ask-assistant').click();
  await hydrate(page, page.getByTestId('assistant-screen'));
  await expect(page).toHaveURL(/prompt=/);
});
