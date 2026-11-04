import { test, expect } from '@playwright/test';
import { setupClerkTestingToken } from '@clerk/testing/playwright';
import {
  createSession,
  createSessionToken,
  createUser,
  listUsers,
} from '@taphoa/e2e/clerk';
import {
  Api,
  API_URL,
  PRODUCT_PHOTO,
  PHOTO,
  button,
  callApi,
  hydrate,
  http,
  openCamera,
  openShop,
  addButton,
  typeAmount,
  uuid7,
  type Product,
} from './fixtures';
import { TEST_CODE } from './clerk-auth';
import path from 'node:path';

// This file uses Playwright's base fixtures: no throwaway stores or Clerk cleanup.
const EMAIL = 'smoke-prod-x9+clerk_test@example.com';
const STORE = 'Smoke test (X9) - do not use';
// The deployed ASSISTANT_MODELS may be paid (z-ai/glm-5.3-flash) or free; any OpenRouter id.
const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/;
// E2E_SMOKE_ENV=test runs the same isolated flow against Railway test (its own smoke store).
const SMOKE_ENV = process.env.E2E_SMOKE_ENV === 'test' ? 'test' : 'production';
const PROD =
  SMOKE_ENV === 'test'
    ? 'https://backend-test-70c2.up.railway.app'
    : 'https://backend-production-5f5c.up.railway.app';

test('production smoke: reusable isolated store, product flow and four assistant turns', async ({
  page,
}, info) => {
  test.setTimeout(720_000);
  page.setDefaultTimeout(25_000);
  expect(process.env.E2E_PRODUCTION_SMOKE).toBe('1');
  expect(API_URL).toBe(PROD);
  expect(process.env.EXPO_PUBLIC_ENVIRONMENT).toBe(SMOKE_ENV);
  expect(process.env.EXPO_PUBLIC_SMOKE).toBe('1');
  expect(process.env.EXPO_PUBLIC_POSTHOG_KEY).toBeTruthy();
  expect(process.env.CLERK_TRACKING_DIR).toBeUndefined();

  const resumeThread = process.env.E2E_SMOKE_RESUME_THREAD;
  if (resumeThread) expect(resumeThread).toMatch(/^[0-9a-f-]{36}$/);
  async function smokeStep(name: string, work: () => Promise<void>) {
    if (resumeThread && !/Sign in|Reuse or enroll|Four short/.test(name)) {
      console.log(`Smoke step already covered before resume: ${name}`);
      return;
    }
    console.log(`Smoke step: ${name}`);
    await test.step(name, work);
  }
  const startedAt = new Date().toISOString();
  const evidence: Record<string, unknown> = { startedAt, steps: [] };
  const steps = evidence.steps as Record<string, unknown>[];
  let storeId: string | undefined;
  let allowCreateStore = false;
  const blocked: string[] = [];
  // Fail closed before forwarding any business write outside our selected smoke store.
  await page.route(`${PROD}/**`, async (route) => {
    const request = route.request();
    const routePath = new URL(request.url()).pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      const create = routePath === '/v1/stores' && allowCreateStore;
      if (
        !create &&
        (!storeId || request.headers()['x-store-id'] !== storeId)
      ) {
        blocked.push(`${request.method()} ${routePath}`);
        await route.abort('blockedbyclient');
        return;
      }
    }
    await route.continue();
  });

  try {
    const candidates = await listUsers({
      email_address_query: EMAIL,
      limit: 100,
    });
    const exact = candidates.filter((user) =>
      user.email_addresses.some((a) => a.email_address === EMAIL),
    );
    expect(exact.length).toBeLessThanOrEqual(1);
    const user =
      exact[0] ??
      (await createUser({ email: EMAIL, firstName: 'Production smoke X9' }));
    const session = await createSession(user.id);
    const token = await createSessionToken(session.id, 3600);
    const me = await http('GET', '/v1/me', { token });
    // The dedicated identity must own only the dedicated store. Never select another membership.
    expect(me.memberships.length).toBeLessThanOrEqual(1);
    if (me.memberships.length) {
      expect(me.memberships[0].store.name).toBe(STORE);
      expect(me.memberships[0].member.role).toBe('lead');
      storeId = me.memberships[0].store.id;
    } else allowCreateStore = true;

    await smokeStep(
      'Sign in with the app email/code screens; onboard once',
      async () => {
        await setupClerkTestingToken({ page });
        await page.goto('/sign-in');
        await hydrate(page, page.getByTestId('auth-sign-in-screen'));
        await page
          .getByRole('textbox', { name: 'Địa chỉ email', exact: true })
          .fill(EMAIL);
        await page.getByTestId('auth-send-code').click();
        await expect(page.getByTestId('auth-code-screen')).toBeVisible({
          timeout: 30_000,
        });
        await page
          .getByRole('textbox', { name: 'Mã xác nhận 6 chữ số' })
          .fill(TEST_CODE);
        await page.getByTestId('auth-verify-code').click();
        if (allowCreateStore) {
          await expect(
            page.getByTestId('onboarding-welcome-screen'),
          ).toBeVisible();
          await page.getByTestId('onboarding-create').click();
          await page
            .getByRole('textbox', { name: 'Tên cửa hàng', exact: true })
            .fill(STORE);
          await page
            .getByRole('textbox', { name: 'Tên của bạn', exact: true })
            .fill('Smoke X9');
          const created = await callApi(page, 'POST', '/v1/stores', () =>
            page.getByTestId('create-store-submit').click(),
          );
          expect(created.body.store.name).toBe(STORE);
          storeId = created.body.store.id;
          allowCreateStore = false;
        }
        await expect(button(page, 'Chụp')).toBeVisible({ timeout: 30_000 });
      },
    );
    const current = await http('GET', '/v1/me', { token });
    expect(current.memberships).toHaveLength(1);
    const membership = current.memberships[0];
    expect(membership.store).toMatchObject({ id: storeId, name: STORE });
    const api = new Api({
      access_token: token,
      clerk_user_id: user.id,
      email: EMAIL,
      ...membership,
    });
    evidence.user = `${user.id.slice(0, 8)}…${user.id.slice(-4)}`;
    evidence.storeId = storeId;
    evidence.memberId = membership.member.id;
    console.log(`Smoke store: ${storeId}; user: ${evidence.user}`);

    let product: Product;
    await smokeStep(
      'Reuse or enroll three clearly named smoke products; set low stock',
      async () => {
        const catalog = await api.get('/v1/products?limit=100');
        const products: Product[] = [];
        for (const [index, name] of [
          'Smoke X9 bánh đỏ',
          'Smoke X9 mì gói',
          'Smoke X9 nước suối',
        ].entries()) {
          const existing = catalog.items.filter(
            (p: Product) => p.name === name,
          );
          expect(existing.length).toBeLessThanOrEqual(1);
          products.push(
            existing[0] ??
              (await api.createProduct({
                name,
                price: 10_000 + index * 1000,
                cost_price: 5000,
                photo: index === 0 ? PRODUCT_PHOTO : PHOTO,
              })),
          );
        }
        product = products[0]!;
        await api.waitForIndex(product.id);
        await api.post(
          `/v1/products/${product.id}/stock-adjustments`,
          { count: 3, note: 'Production smoke X9' },
          { 'Idempotency-Key': uuid7() },
        );
        steps.push({ step: 'catalog', productIds: products.map((p) => p.id) });
        await openShop(page, '/inventory');
        await expect(button(page, /^Smoke X9 bánh đỏ, /)).toBeVisible();
      },
    );

    await smokeStep('Camera recognition and a cash checkout', async () => {
      await openCamera(page);
      const scan = await callApi(page, 'POST', '/v1/recognition/scans', () =>
        button(page, 'Chụp').click(),
      );
      expect(scan.body.detections[0].candidates[0].product_id).toBe(
        product!.id,
      );
      await expect(addButton(page)).toBeEnabled();
      await addButton(page).click();
      await button(page, /^Giỏ hàng:/).click();
      await button(page, 'Hiện mã QR thanh toán').click();
      await page.getByRole('radio', { name: 'Tiền mặt', exact: true }).click();
      const sale = await callApi(page, 'POST', '/v1/sales', () =>
        button(page, 'Đã nhận tiền').click(),
      );
      steps.push({ step: 'cash-sale', id: sale.body.id });
      await expect(button(page, 'Chụp')).toBeVisible();
      // A real loose-item sale also exercises manual-lines and void metrics.
      const manual = await api.createSale({
        lines: [{ manual_label: 'Smoke X9 kẹo rời', unit_price: 1000 }],
      });
      await api.post(
        `/v1/sales/${manual.id}/void`,
        { reason: 'Production smoke X9: void test sale' },
        { 'Idempotency-Key': uuid7() },
      );
    });

    await smokeStep(
      'Reuse the smoke customer, record credit, collect it through the UI',
      async () => {
        const customers = await api.get('/v1/customers?limit=100');
        const customer =
          customers.items.find(
            (c: { name: string }) => c.name === 'Smoke X9 khách thử',
          ) ??
          (await api.post('/v1/customers', {
            id: uuid7(),
            name: 'Smoke X9 khách thử',
          }));
        const id = uuid7();
        await api.post(
          '/v1/sales',
          {
            id,
            sold_at: new Date().toISOString(),
            payment_method: 'credit',
            total: product!.price,
            credit: { customer_id: customer.id, amount: product!.price },
            lines: [
              {
                id: uuid7(),
                product_id: product!.id,
                quantity: 1,
                unit_price: product!.price,
                source: 'grid',
              },
            ],
          },
          { 'Idempotency-Key': id },
        );
        await page.goto('/debts');
        await expect(
          page.getByRole('heading', { name: 'Sổ nợ', exact: true }),
        ).toBeVisible();
        await button(page, /^Smoke X9 khách thử, /).click();
        await expect(button(page, 'Thu nợ')).toBeVisible();
        await button(page, 'Thu nợ').click();
        const repayment = await callApi(
          page,
          'POST',
          `/v1/customers/${customer.id}/repayments`,
          () => button(page, 'Xác nhận thu nợ').click(),
        );
        expect(repayment.body.balance_after).toBe(0);
        steps.push({
          step: 'credit-and-repay',
          customerId: customer.id,
          saleId: id,
        });
      },
    );

    await smokeStep(
      'Reports, inventory, receipt OCR and confirmation',
      async () => {
        await openShop(page, '/dashboard');
        await expect(
          page.getByRole('heading', { name: 'Báo cáo', exact: true }),
        ).toBeVisible();
        await page.getByRole('radio', { name: 'Tuần', exact: true }).click();
        await page.getByRole('radio', { name: 'Ngày', exact: true }).click();
        await page.goto('/stock');
        await expect(page.getByTestId('stock-list')).toBeVisible();
        const image = await api.uploadImage(
          path.join(
            __dirname,
            '../../backend/crates/recognition/tests/fixtures/receipts/receipt-1.jpg',
          ),
          'expense_receipt',
        );
        try {
          const receipt = await api.post(
            '/v1/receipts',
            { image_id: image },
            { 'Idempotency-Key': uuid7() },
          );
          expect(receipt.lines.length).toBeGreaterThan(0);
          // Explicitly map the fixture lines to the smoke product; never use a foreign product id.
          await api.post(
            `/v1/receipts/${receipt.id}/confirm`,
            {
              paid_with: 'other',
              lines: receipt.lines.map((line: { id: string }) => ({
                line_id: line.id,
                product_id: product!.id,
                quantity: 1,
                cost: 1000,
              })),
            },
            { 'Idempotency-Key': uuid7() },
          );
          await page.goto('/receipts');
          steps.push({ step: 'receipt', id: receipt.id, status: 'confirmed' });
        } catch (error) {
          // Web may reach a production deployment without OCR weights. Record the exact API code.
          if (
            !(error instanceof Error) ||
            !('status' in error) ||
            ![422, 503].includes(Number(error.status))
          )
            throw error;
          steps.push({
            step: 'receipt',
            status: 'unavailable',
            httpStatus: Number(error.status),
          });
        }
        await page.goto('/digest?entry=card');
        await expect(page.getByRole('heading')).toBeVisible();
      },
    );

    await smokeStep(
      'Close day once; reopening an existing close is read-only',
      async () => {
        const report = await api.get('/v1/reports/today');
        await openShop(page, '/dashboard');
        await button(page, 'Chốt sổ').click();
        if (!report.day_close) {
          await typeAmount(page, Math.max(0, report.expected_cash));
          await callApi(
            page,
            'PUT',
            `/v1/day-closes/${report.business_date}`,
            () => button(page, 'Chốt sổ hôm nay').click(),
          );
        } else
          await expect(
            page.getByText('Đã chốt sổ', { exact: true }),
          ).toBeVisible();
        steps.push({
          step: 'day-close',
          date: report.business_date,
          reused: !!report.day_close,
        });
      },
    );

    await smokeStep(
      'Four short Vietnamese assistant turns, thumbs and action decision',
      async () => {
        const turns: Record<string, unknown>[] = [];
        evidence.turns = turns;
        // Each ask observes the real SSE request and waits for a newly completed answer.
        async function ask(question: string) {
          const count = await page.getByTestId('feedback-up').count();
          const response = page.waitForResponse(
            (r) =>
              r.request().method() === 'POST' &&
              /\/assistant\/threads\/[^/]+\/messages$/.test(
                new URL(r.url()).pathname,
              ),
            { timeout: 30_000 },
          );
          console.log(`Smoke assistant turn ${turns.length + 1}`);
          await page.getByTestId('assistant-input').fill(question);
          await page.getByTestId('assistant-send').click();
          const stream = await response;
          expect(stream.status()).toBe(200);
          await expect(page.getByTestId('feedback-up')).toHaveCount(count + 1, {
            timeout: 150_000,
          });
          await expect(page.getByTestId('assistant-retry')).toHaveCount(0);
          const thread = await api.get(
            new URL(stream.url()).pathname.replace(/\/messages$/, ''),
          );
          const reply = thread.messages.at(-1);
          expect(reply.role).toBe('assistant');
          expect(reply.content.trim().length).toBeGreaterThan(0);
          expect(reply.model).toMatch(MODEL_ID);
          turns.push({
            question,
            completedAt: new Date().toISOString(),
            completed: true,
          });
        }
        await openShop(page, '/inventory');
        await button(page, 'Mở trợ lý').click();
        await hydrate(page, page.getByTestId('assistant-screen'));
        if (!resumeThread) {
          // Reruns start a fresh thread, independent of the app's latest-thread auto selection.
          await page.getByTestId('assistant-new-chat').click();
          await expect(page.getByTestId('assistant-empty')).toBeVisible();
        }
        if (resumeThread) {
          const detail = await api.get(`/v1/assistant/threads/${resumeThread}`);
          expect(detail.messages).toHaveLength(2);
          expect(detail.messages[0].content).toBe(
            'Hôm nay bán được bao nhiêu? Trả lời ngắn.',
          );
          expect(detail.messages[1].model).toMatch(MODEL_ID);
          await page.goto(
            `/assistant?entry=button&screen=inventory&threadId=${resumeThread}`,
          );
          await expect(page.getByTestId('feedback-up')).toHaveCount(1);
          turns.push({
            question: detail.messages[0].content,
            resumed: true,
            messageId: detail.messages[1].id,
            model: detail.messages[1].model,
            completed: true,
          });
        } else await ask('Hôm nay bán được bao nhiêu? Trả lời ngắn.');
        await callApi(
          page,
          'POST',
          /\/v1\/assistant\/messages\/[^/]+\/feedback$/,
          () => page.getByTestId('feedback-up').last().click(),
        );
        await ask('Mặt hàng nào sắp hết? Trả lời ngắn.');
        await ask(
          'Đề xuất thêm khoản chi điện 1000 đồng hôm nay, trả từ tiền túi. Chỉ đề xuất, chưa thực hiện.',
        );
        if (await page.getByTestId('action-reject').last().isVisible()) {
          await callApi(
            page,
            'POST',
            /\/v1\/assistant\/actions\/[^/]+\/reject$/,
            () => page.getByTestId('action-reject').last().click(),
          );
          evidence.actionDecision = 'rejected';
        } else evidence.actionDecision = 'model did not propose an action';
        await page.getByTestId('assistant-close').click();
        await api.post(
          `/v1/products/${product!.id}/stock-adjustments`,
          { count: 2, note: 'Smoke X9: show restock chip' },
          { 'Idempotency-Key': uuid7() },
        );
        await openCamera(page);
        const chip = page.getByTestId('next-step-chip-restock');
        await expect(chip).toBeVisible({ timeout: 15_000 });
        console.log('Smoke assistant turn 4 from restock chip');
        const chipResponse = page.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            /\/assistant\/threads\/[^/]+\/messages$/.test(
              new URL(r.url()).pathname,
            ),
        );
        await chip.click();
        await expect(page.getByTestId('assistant-screen')).toBeVisible();
        const stream = await chipResponse;
        expect(stream.status()).toBe(200);
        await expect(page.getByTestId('feedback-up').first()).toBeVisible({
          timeout: 150_000,
        });
        const chipThread = await api.get(
          new URL(stream.url()).pathname.replace(/\/messages$/, ''),
        );
        expect(chipThread.messages.at(-1).role).toBe('assistant');
        expect(chipThread.messages.at(-1).model).toMatch(MODEL_ID);
        turns.push({
          question: 'next-step restock chip prompt',
          completedAt: new Date().toISOString(),
          completed: true,
        });
        expect(turns).toHaveLength(4);
        expect(
          evidence.actionDecision,
          'one real proposed action must be decided',
        ).toBe('rejected');
      },
    );
    // Allow SDK's normal flush interval; no synthetic analytics capture is injected.
    await page.waitForTimeout(35_000);
    expect(blocked).toEqual([]);
  } finally {
    evidence.finishedAt = new Date().toISOString();
    evidence.blockedWrites = blocked;
    await info.attach('production-smoke-evidence', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    });
    console.log(JSON.stringify(evidence, null, 2));
  }
});
