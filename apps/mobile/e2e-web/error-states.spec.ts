/* eslint-disable react-hooks/rules-of-hooks, no-empty-pattern -- Playwright fixtures call `use`, which is not a React hook, and destructure nothing */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { setupClerkTestingToken } from '@clerk/testing/playwright';
import type { Page, TestInfo } from '@playwright/test';

import { businessDate } from '../src/lib/date';
import {
  API_URL,
  button,
  createNewcomer,
  expect,
  goOffline,
  hydrate,
  openShop,
  seedTradingDay,
  signInAs,
  signInScreen,
  test as base,
  TEST_CODE,
  typeAmount,
  uuid7,
  waitForApi,
  welcomeScreen,
} from './fixtures';

/**
 * Error states: every failure shows its own Vietnamese message and a way out, never a blank
 * page, an endless spinner or a message for a different problem. Failures are provoked the way
 * a phone meets them: `context.setOffline(true)` for a dead network, `page.route` for a Clerk
 * or API answer (429, 401, 403, 409, 500) and for a route chunk that cannot be fetched.
 *
 * The specs abort requests on purpose, so the shared console guard (which rejects any failed
 * request) is switched off here; each spec asserts what the person sees instead. Screenshots of
 * the error states go to E2E_EVIDENCE_DIR (or the test output folder).
 */
const test = base.extend({
  consoleGuard: [
    async ({}, use) => {
      await use();
    },
    // the base declares it `auto`; the override must stay automatic to replace it everywhere
    { scope: 'test', auto: true } as { scope: 'test' },
  ],
});

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const dir = process.env.E2E_EVIDENCE_DIR ?? testInfo.outputDir;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

const byId = (page: Page, id: string) => page.getByTestId(id);
const field = (page: Page, label: string) =>
  page.getByRole('textbox', { name: label, exact: true });

/** Opens a route with a dynamic segment in the running app (the static export has no page for it). */
async function openInApp(page: Page, route: string) {
  await page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
}

// ---- #175 sign-in and code screens ------------------------------------------------------

const NETWORK = 'Không kết nối được. Kiểm tra mạng rồi thử lại.';
const RATE_LIMITED = 'Thử quá nhiều lần. Đợi một lúc rồi thử lại.';
const EXPIRED = 'Mã đã hết hạn. Vui lòng gửi lại mã.';
const SUPPORT = 'Tài khoản cần thêm bước xác minh. Vui lòng liên hệ hỗ trợ.';
const GENERIC = 'Không đăng nhập được. Vui lòng thử lại.';

const CLERK = {
  create: /\/v1\/client\/sign_ins(\?|$)/,
  prepare: /\/v1\/client\/sign_ins\/[^/]+\/prepare_first_factor/,
  attempt: /\/v1\/client\/sign_ins\/[^/]+\/attempt_first_factor/,
};

type Failure = 'abort' | 'rate-limit' | 'expired';

/** Fails every POST to the matching Clerk Frontend API call. */
async function failClerk(page: Page, pattern: RegExp, failure: Failure) {
  await page.route(pattern, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (failure === 'abort') return route.abort('internetdisconnected');
    const rateLimited = failure === 'rate-limit';
    return route.fulfill({
      status: rateLimited ? 429 : 422,
      contentType: 'application/json',
      body: JSON.stringify({
        errors: [
          {
            code: rateLimited ? 'too_many_requests' : 'verification_expired',
            message: rateLimited ? 'Too many requests' : 'Code expired',
            long_message: rateLimited ? 'Too many requests' : 'Code expired',
          },
        ],
        clerk_trace_id: 'e2e',
      }),
    });
  });
}

async function openSignIn(page: Page) {
  await setupClerkTestingToken({ page });
  await page.goto('/sign-in');
  await hydrate(page, signInScreen(page));
}

/** Types the address and presses "Gửi mã" (the Clerk failure, if any, is already routed). */
async function sendCode(page: Page, email: string) {
  await field(page, 'Địa chỉ email').fill(email);
  await button(page, 'Gửi mã').click();
}

/** Reaches the code screen of an existing user, with the real Clerk, before anything fails. */
async function openCodeScreen(page: Page) {
  const user = await createNewcomer();
  await openSignIn(page);
  await sendCode(page, user.email);
  await expect(byId(page, 'auth-code-screen')).toBeVisible({ timeout: 30_000 });
  return user;
}

const failures = (page: Page) => ({
  message: (text: string) => page.getByText(text, { exact: true }),
  wrong: [SUPPORT, GENERIC].map((text) =>
    page.getByText(text, { exact: true }),
  ),
});

test.describe('#175 sign-in and code failures', () => {
  test.use({ signedIn: false });

  test('sending the code: network down says so', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const user = await createNewcomer();
    await openSignIn(page);
    await failClerk(page, CLERK.create, 'abort');
    await sendCode(page, user.email);
    await expect(failures(page).message(NETWORK)).toBeVisible({
      timeout: 45_000,
    });
    await expect(failures(page).wrong[1]).toHaveCount(0);
    await shot(page, testInfo, 'issue-175-send-network');
  });

  test('sending the code: Clerk 429 says too many tries', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const user = await createNewcomer();
    await openSignIn(page);
    await failClerk(page, CLERK.create, 'rate-limit');
    await sendCode(page, user.email);
    await expect(failures(page).message(RATE_LIMITED)).toBeVisible({
      timeout: 45_000,
    });
    await expect(failures(page).wrong[1]).toHaveCount(0);
    await shot(page, testInfo, 'issue-175-send-rate-limited');
  });

  test('the code: an expired code says it expired', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await openCodeScreen(page);
    await failClerk(page, CLERK.attempt, 'expired');
    await field(page, 'Mã xác nhận 6 chữ số').fill(TEST_CODE);
    await button(page, 'Xác nhận').click();
    await expect(failures(page).message(EXPIRED)).toBeVisible({
      timeout: 45_000,
    });
    await expect(failures(page).wrong[0]).toHaveCount(0);
    await shot(page, testInfo, 'issue-175-code-expired');
  });

  test('the code: Clerk 429 says too many tries', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await openCodeScreen(page);
    await failClerk(page, CLERK.attempt, 'rate-limit');
    await field(page, 'Mã xác nhận 6 chữ số').fill(TEST_CODE);
    await button(page, 'Xác nhận').click();
    await expect(failures(page).message(RATE_LIMITED)).toBeVisible({
      timeout: 45_000,
    });
    await expect(failures(page).wrong[0]).toHaveCount(0);
    await shot(page, testInfo, 'issue-175-code-rate-limited');
  });

  test('the code: network down says so', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await openCodeScreen(page);
    await failClerk(page, CLERK.attempt, 'abort');
    await field(page, 'Mã xác nhận 6 chữ số').fill(TEST_CODE);
    await button(page, 'Xác nhận').click();
    await expect(failures(page).message(NETWORK)).toBeVisible({
      timeout: 45_000,
    });
    await expect(failures(page).wrong[0]).toHaveCount(0);
    await shot(page, testInfo, 'issue-175-code-network');
  });

  test('resending the code: network down says so', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await openCodeScreen(page);
    await failClerk(page, CLERK.prepare, 'abort');
    await button(page, 'Gửi lại mã').click();
    await expect(failures(page).message(NETWORK)).toBeVisible({
      timeout: 45_000,
    });
    await shot(page, testInfo, 'issue-175-resend-network');
  });

  test('the code: a wrong code (the real Clerk answer) is still its own message', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openCodeScreen(page);
    await field(page, 'Mã xác nhận 6 chữ số').fill('000000');
    await button(page, 'Xác nhận').click();
    await expect(
      failures(page).message('Mã xác nhận không đúng. Vui lòng thử lại.'),
    ).toBeVisible({ timeout: 45_000 });
  });
});

// ---- #177 a route chunk that cannot be loaded -------------------------------------------

test.describe('#177 route chunk failure', () => {
  test.use({ signedIn: false });

  test('a screen that cannot load shows a message and a retry, not a blank page', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const user = await createNewcomer();
    await openSignIn(page);
    await page.route(/verify-code-[0-9a-f]+\.js/, (route) =>
      route.abort('internetdisconnected'),
    );
    await sendCode(page, user.email);
    const failed = byId(page, 'route-error');
    await expect(failed).toBeVisible({ timeout: 45_000 });
    await expect(
      failed.getByText('Không tải được màn hình. Kiểm tra mạng rồi thử lại.'),
    ).toBeVisible();
    await shot(page, testInfo, 'issue-177-route-chunk');

    // the network is back: "Thử lại" reloads the app instead of leaving it white
    await page.unroute(/verify-code-[0-9a-f]+\.js/);
    await button(page, 'Thử lại').click();
    await hydrate(page, signInScreen(page));
    await expect(failed).toHaveCount(0);
  });
});

// ---- #178 create store, join store and the account load ---------------------------------

test.describe('#178 onboarding failures', () => {
  test.use({ signedIn: false });

  async function newcomerOnWelcome(page: Page) {
    const newcomer = await createNewcomer();
    await signInAs(page, newcomer);
    await expect(welcomeScreen(page)).toBeVisible();
  }

  async function submitJoin(page: Page) {
    await button(page, 'Tham gia bằng mã').click();
    await field(page, 'Mã mời').fill('K7Q4MZ2P9HXDT3VA');
    await field(page, 'Tên của bạn').fill('Bé Út');
    await byId(page, 'join-store-submit').click();
  }

  async function submitCreate(page: Page) {
    await byId(page, 'onboarding-create').click();
    await field(page, 'Tên cửa hàng').fill('Tạp hóa Cô Ba');
    await field(page, 'Tên của bạn').fill('Cô Ba');
    await byId(page, 'create-store-submit').click();
  }

  const answer = (
    page: Page,
    route: string,
    status: number,
    body: Record<string, unknown>,
  ) =>
    page.route(`**${route}`, (request) =>
      request.request().method() === 'POST'
        ? request.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(body),
          })
        : request.fallback(),
    );

  test('join store: 409 already a member says so', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await newcomerOnWelcome(page);
    await answer(page, '/v1/auth/join', 409, {
      error: 'already a member',
      code: 'already_member',
    });
    await submitJoin(page);
    await expect(
      page.getByText('Bạn đã là thành viên của cửa hàng này.'),
    ).toBeVisible();
    await expect(page.getByText('Có lỗi xảy ra. Thử lại.')).toHaveCount(0);
    await shot(page, testInfo, 'issue-178-join-409');
  });

  test('join store: 403 says there is no permission', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await newcomerOnWelcome(page);
    await answer(page, '/v1/auth/join', 403, { error: 'forbidden' });
    await submitJoin(page);
    await expect(
      page.getByText('Tài khoản này không có quyền làm việc này.'),
    ).toBeVisible();
    await expect(page.getByText('Có lỗi xảy ra. Thử lại.')).toHaveCount(0);
    await shot(page, testInfo, 'issue-178-join-403');
  });

  test('create store: 401 asks to sign in again', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await newcomerOnWelcome(page);
    await answer(page, '/v1/stores', 401, { error: 'unauthorized' });
    await submitCreate(page);
    await expect(
      page.getByText(
        'Phiên đăng nhập đã hết hạn. Hãy đăng xuất rồi đăng nhập lại.',
      ),
    ).toBeVisible();
    await expect(page.getByText('Có lỗi xảy ra. Thử lại.')).toHaveCount(0);
    await shot(page, testInfo, 'issue-178-create-401');
  });

  test('create store: 403 says there is no permission', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await newcomerOnWelcome(page);
    await answer(page, '/v1/stores', 403, { error: 'forbidden' });
    await submitCreate(page);
    await expect(
      page.getByText('Tài khoản này không có quyền làm việc này.'),
    ).toBeVisible();
    await shot(page, testInfo, 'issue-178-create-403');
  });
});

test.describe('#178 account load', () => {
  test('GET /v1/me answering 500 blames the server, not the network', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.route(/\/v1\/me(\?|$)/, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal' }),
      }),
    );
    // The app keeps a copy of `me` in storage (stale-while-revalidate: it opens the shop from
    // that copy and a failing refresh leaves it). The save is throttled by a second, so whether
    // the copy exists at reload depended on timing. The error screen is for a cold start with
    // no copy: drop it before the page boots.
    await page.addInitScript(
      (key) => localStorage.removeItem(key),
      // CACHE_STORAGE_KEY in src/lib/offline/persist.ts
      'taphoa-query-cache',
    );
    const answered = page.waitForResponse(
      (r) => /\/v1\/me(\?|$)/.test(r.url()) && r.status() === 500,
    );
    await page.reload();
    await answered;
    await expect(
      page.getByText('Máy chủ đang bận, chưa tải được tài khoản. Thử lại sau.'),
    ).toBeVisible();
    await expect(
      page.getByText('Không tải được tài khoản. Kiểm tra mạng rồi thử lại.'),
    ).toHaveCount(0);
    await shot(page, testInfo, 'issue-178-me-500');
  });
});

// ---- offline screens ---------------------------------------------------------------------

test.describe('offline', () => {
  test('#204 the dashboard says so instead of an endless skeleton', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await openShop(page, '/dashboard');
    await expect(page.getByLabel(/^Doanh thu \d/)).toBeVisible();
    await goOffline(page);
    await page.getByRole('radio', { name: 'Tuần' }).click();
    await expect(byId(page, 'dashboard-offline')).toBeVisible();
    await expect(
      page.getByText(
        'Không tải được báo cáo. Không có mạng, số liệu sẽ cập nhật khi có mạng.',
      ),
    ).toBeVisible();
    await expect(byId(page, 'dashboard-skeleton')).toHaveCount(0);
    await expect(button(page, 'Thử lại')).toBeVisible();
    await shot(page, testInfo, 'issue-204-dashboard-offline');

    // the network returns: the figures load by themselves
    await page.context().setOffline(false);
    await expect(page.getByLabel(/^Doanh thu \d/)).toBeVisible();
    await expect(byId(page, 'dashboard-offline')).toHaveCount(0);
  });

  test('#246 Kho and Tồn kho say so with a retry instead of a skeleton or spinner', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    // The catalog and the stock never load on this phone: their first requests fail just as the
    // network drops (a query that cannot retry because it is offline waits, which is the case
    // being fixed). Both screens are opened first, online, so their code is already loaded.
    let release!: () => void;
    const dropped = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/v1\/(products|stock)(\?|$)/, async (route) => {
      await dropped;
      await route.abort('internetdisconnected').catch(() => undefined);
    });
    await openShop(page, '/account');
    await page.getByRole('tab', { name: 'Kho', exact: true }).click();
    await page.getByRole('radio', { name: 'Tồn kho' }).click();
    await expect(page.getByRole('heading', { name: 'Tồn kho' })).toBeVisible();
    await page.context().setOffline(true);
    release();

    await expect(byId(page, 'stock-offline')).toBeVisible();
    await expect(
      page.getByText(
        'Không tải được tồn kho. Không có mạng, danh sách sẽ tải khi có mạng.',
      ),
    ).toBeVisible();
    await expect(button(page, 'Thử lại')).toBeVisible();
    await shot(page, testInfo, 'issue-246-stock-offline');

    await page.getByRole('radio', { name: 'Sản phẩm' }).click();
    // the Kho tab stays mounted below the stock screen, so two copies exist: take the top one
    const kho = byId(page, 'inventory-offline').last();
    await expect(kho).toBeVisible();
    await expect(
      kho.getByText(
        'Không tải được sản phẩm. Không có mạng, danh sách sẽ tải khi có mạng.',
      ),
    ).toBeVisible();
    await expect(kho.getByRole('button', { name: 'Thử lại' })).toBeVisible();
    await expect(byId(page, 'inventory-skeleton')).toHaveCount(0);
    await shot(page, testInfo, 'issue-246-inventory-offline');
  });

  test('#205 closing the day offline is refused with a message and sends nothing', async ({
    page,
    store,
  }, testInfo) => {
    test.setTimeout(120_000);
    await seedTradingDay(store.api);
    const puts: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'PUT' &&
        request.url().includes('/v1/day-closes/')
      )
        puts.push(request.url());
    });
    await openShop(page, '/dashboard');
    await button(page, 'Chốt sổ').click();
    await expect(page.getByRole('heading', { name: 'Chốt sổ' })).toBeVisible();
    await expect(page.getByLabel(/^Tiền mặt dự kiến/)).toBeVisible();
    await typeAmount(page, 30_000);
    await goOffline(page);
    await button(page, 'Chốt sổ hôm nay').click();
    await expect(
      page.getByText(
        'Không có mạng nên chưa chốt được sổ. Tiền đếm được vẫn còn, thử lại khi có mạng.',
      ),
    ).toBeVisible();
    await expect(button(page, 'Chốt sổ hôm nay')).toBeEnabled();
    await shot(page, testInfo, 'issue-205-close-offline');

    // back online nothing is sent behind the seller's back
    await page.context().setOffline(false);
    await page.waitForTimeout(3_000);
    expect(puts).toEqual([]);
    await expect(
      store.api.get(`/v1/day-closes/${businessDate()}`),
    ).rejects.toMatchObject({ status: 404 });

    // the seller closes it on purpose, once
    const closed = waitForApi(page, 'PUT', /^\/v1\/day-closes\//);
    await button(page, 'Chốt sổ hôm nay').click();
    expect((await closed).status).toBeLessThan(300);
    expect(puts).toHaveLength(1);
  });

  test('#205 a repayment offline is refused with a message and recorded once after reconnecting', async ({
    page,
    store,
  }, testInfo) => {
    test.setTimeout(120_000);
    const customerId = uuid7();
    await store.api.post('/v1/customers', {
      id: customerId,
      name: 'Chị Lan',
    });
    await store.api.post(
      `/v1/customers/${customerId}/adjustments`,
      { amount: 50_000, reason: 'Nợ cũ' },
      { 'Idempotency-Key': uuid7() },
    );
    const posts: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().includes(`/v1/customers/${customerId}/repayments`)
      )
        posts.push(request.url());
    });
    await openInApp(page, `/customer/${customerId}`);
    await expect(byId(page, 'customer-balance')).toHaveAccessibleName(
      'Đang nợ 50.000đ',
    );
    await button(page, 'Thu nợ').click();
    await page.getByRole('textbox', { name: 'Số tiền thu' }).fill('1000');
    await goOffline(page);
    await button(page, 'Xác nhận thu nợ').click();
    await expect(
      page.getByText(
        'Không có mạng nên chưa ghi được khoản thu. Số tiền vẫn còn, thử lại khi có mạng.',
      ),
    ).toBeVisible();
    await expect(button(page, 'Xác nhận thu nợ')).toBeEnabled();
    await expect(
      page.getByRole('textbox', { name: 'Số tiền thu' }),
    ).toHaveValue('1000');
    expect(posts).toEqual([]);
    await shot(page, testInfo, 'issue-205-repayment-offline');

    await page.context().setOffline(false);
    const repayment = waitForApi(
      page,
      'POST',
      `/v1/customers/${customerId}/repayments`,
    );
    await button(page, 'Xác nhận thu nợ').click();
    expect((await repayment).status).toBe(201);
    await expect(byId(page, 'customer-balance')).toHaveAccessibleName(
      'Đang nợ 49.000đ',
    );
    expect(posts).toHaveLength(1);
  });

  test('#243 confirming a receipt offline says so and keeps the draft', async ({
    page,
    store,
  }, testInfo) => {
    test.setTimeout(120_000);
    const coca = await store.api.createProduct({
      name: 'Coca-Cola lon 330ml',
      price: 10_000,
      cost_price: 7_500,
    });
    const receiptId = uuid7();
    const receipt = {
      id: receiptId,
      status: 'draft',
      image_id: uuid7(),
      image_url: 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=',
      total: 75_000,
      parser: 'fallback',
      model: null,
      lines: [
        {
          id: uuid7(),
          position: 0,
          raw_text: 'Coca lon 330 x10',
          product_name: coca.name,
          quantity: 10,
          cost: 75_000,
          product_id: coca.id,
          match_confidence: 0.99,
          candidates: [],
        },
      ],
      timings: { ocr: 1, parse: 1, decisions: 1, total: 3 },
      expense_id: null,
      created_at: new Date().toISOString(),
      confirmed_at: null,
    };
    // a draft the camera would have read; only its read is served here, the confirm is real
    await page.route(new RegExp(`/v1/receipts/${receiptId}$`), (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: receipt })
        : route.fallback(),
    );
    const confirms: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes(`/v1/receipts/${receiptId}/confirm`))
        confirms.push(request.url());
    });
    await openInApp(page, `/receipt/${receiptId}`);
    await expect(
      page.getByRole('heading', { name: 'Kiểm tra hóa đơn' }),
    ).toBeVisible();
    await button(page, 'Xong, xem lại').click();
    await expect(button(page, 'Xác nhận nhập kho')).toBeEnabled();
    await goOffline(page);
    await button(page, 'Xác nhận nhập kho').click();
    await expect(
      page.getByText(
        'Không có mạng nên chưa nhập kho được. Bản nháp vẫn còn, thử lại khi có mạng.',
      ),
    ).toBeVisible();
    await expect(button(page, 'Xác nhận nhập kho')).toBeEnabled();
    expect(confirms).toEqual([]);
    await shot(page, testInfo, 'issue-243-receipt-offline');
  });

  test('#156 the voice sheet offline falls back to on-device recognition instead of "Đang hiểu…" forever', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const uploads: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(`${API_URL}/v1/voice/utterances`))
        uploads.push(request.url());
    });
    await page.goto('/voice?entry=longpress&fixture=two-line-sale.m4a');
    await hydrate(page, byId(page, 'voice-listening'));
    await goOffline(page);
    await button(page, 'Xong, hiểu lời vừa nói').click();
    await expect(byId(page, 'voice-fallback')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Chưa gửi được lên máy chủ')).toBeVisible();
    await expect(page.getByText('Đang hiểu…')).toHaveCount(0);
    expect(uploads).toEqual([]);
    await shot(page, testInfo, 'issue-156-voice-offline');
  });
});
