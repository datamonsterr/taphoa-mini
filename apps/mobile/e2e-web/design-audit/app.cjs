const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { repo, output, launchOptions } = require('./common.cjs');
const mockFetch = require('./mock-loader.cjs');
const { registerImage, getMockDb } = require('../../src/test/mock/db.ts');
const { PRODUCT_IDS } = require('../../src/test/mock/fixtures.ts');
const { createReceipt } = require('../../src/test/mock/stockReceipts.ts');
const { setNextScanDocument } = require('../../src/test/mock/scenario.ts');
const { setDigestFixture } = require('../../src/test/mock/assistant.ts');

const base = process.env.DESIGN_AUDIT_APP_URL || 'http://localhost:8099';
const defaults = [
  'inventory',
  'dashboard',
  'account',
  'stock',
  'debts',
  'digest',
  'sales',
  'receipts',
  'expense',
  'close',
  'cart',
  'pay',
  'assistant',
  'voice',
  'enroll',
];
// Names may be routes, or a route plus one of the explicitly supported states.
const selections = process.argv
  .slice(2)
  .flatMap((arg) => arg.split(','))
  .filter(Boolean);
const targets = selections.length ? selections : defaults;
const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: 'user_test', sid: 'sess_audit', exp: 4102444800, iat: 1794000000 })).toString('base64url')}.x`;
const now = Date.now();
const user = {
  object: 'user',
  id: 'user_test',
  first_name: 'Chị',
  last_name: 'Lan',
  username: null,
  primary_email_address_id: 'email_audit',
  email_addresses: [
    {
      object: 'email_address',
      id: 'email_audit',
      email_address: 'audit@example.test',
      verification: { status: 'verified', strategy: 'email_code' },
    },
  ],
  phone_numbers: [],
  web3_wallets: [],
  external_accounts: [],
  organization_memberships: [],
  public_metadata: {},
  unsafe_metadata: {},
  private_metadata: {},
  created_at: now,
  updated_at: now,
};
const session = {
  last_active_token: { object: 'token', jwt },
  object: 'session',
  id: 'sess_audit',
  status: 'active',
  last_active_at: now,
  expire_at: now + 86400000,
  abandon_at: now + 86400000,
  created_at: now,
  updated_at: now,
  user,
  public_user_data: {
    identifier: 'audit@example.test',
    first_name: 'Chị',
    last_name: 'Lan',
    image_url: '',
  },
  last_active_organization_id: null,
};

async function setup(page, signedOut, welcome, understanding) {
  if (!signedOut) {
    // Fetch the public development instance's client envelope, then replace its identity.
    await page.route('**/v1/client?**', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      for (const key of ['response', 'client']) {
        if (json[key]) {
          json[key].sessions = [session];
          json[key].last_active_session_id = session.id;
        }
      }
      await route.fulfill({ response, json });
    });
    await page.route('**/v1/client/sessions/**', (route) =>
      route.fulfill({
        status: 200,
        json: { response: { object: 'token', jwt } },
      }),
    );
  }
  await page.route('http://localhost:8080/**', async (route) => {
    const request = route.request();
    if (
      understanding &&
      new URL(request.url()).pathname === '/v1/voice/utterances'
    ) {
      await new Promise((resolve) => setTimeout(resolve, 30000));
      return route.abort();
    }
    if (welcome && new URL(request.url()).pathname === '/v1/me') {
      return route.fulfill({
        json: { clerk_user_id: 'user_test', profile: null, memberships: [] },
      });
    }
    // The in-memory mock has no live SSE endpoint. A clean empty response avoids a 404 loop.
    if (new URL(request.url()).pathname === '/v1/events')
      return route.fulfill({ status: 204 });
    // The test mock does not implement sync; preserve its 404, which the app tolerates.
    const headers = {
      ...request.headers(),
      authorization: 'Bearer mock-token',
    };
    const response = await mockFetch(request.url(), {
      method: request.method(),
      headers,
      body: request.postData() || undefined,
    });
    if (
      new URL(request.url()).pathname === '/v1/sync/changes' &&
      response.status !== 404
    )
      throw new Error('Expected the test mock sync endpoint to return 404');
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.route('https://mock.local/**', (route) => {
    const url = route.request().url();
    const name = url.includes('haohao')
      ? 'hao-hao'
      : url.includes('oreo')
        ? 'oreo'
        : 'coca-cola';
    return route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      body: fs.readFileSync(
        path.join(repo, 'docs/design/canvas/img', `${name}.jpg`),
      ),
    });
  });
}

async function main() {
  const lanId = '00000000-0000-4000-8000-000000001234';
  await mockFetch('http://localhost:8080/v1/customers', {
    method: 'POST',
    headers: {
      authorization: 'Bearer mock-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: lanId,
      name: 'Chị Lan',
      phone: '0912345678',
    }),
  });
  const seededLan = getMockDb().customers.find((c) => c.id === lanId);
  if (seededLan) {
    seededLan.last_activity_at = new Date(
      Date.now() - 8 * 86400000,
    ).toISOString();
  }

  const haohaoProd = getMockDb().products.find(
    (p) => p.product.id === PRODUCT_IDS.haohao,
  );
  if (haohaoProd) {
    haohaoProd.product.sales_rate = 6;
  }

  const browser = await chromium.launch(launchOptions());
  try {
    for (const target of targets) {
      const [rawRoute, state] = target.split(':');
      let route = rawRoute.replace(/^\//, '') || 'index';
      const requestedRoute = route;
      if (route === 'receipt' && ['edit', 'summary'].includes(state)) {
        const image = registerImage({ contentType: 'image/jpeg', byteSize: 1 });
        const r = createReceipt(image.id);
        r.supplier = 'Minh Phát';
        r.ocr_line_count = 12;
        route = `receipt/${r.id}`;
      } else if (['customer', 'debts'].includes(route) && state === 'seeded') {
        const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const date = new Date().toISOString();
        const existing = getMockDb().customers.find((c) => c.id === id);
        if (!existing) {
          getMockDb().customers.push({
            id,
            name: 'Chị Lan',
            phone: '0912345678',
            note: null,
            credit_limit: 5000000,
            balance: 1250000,
            oldest_debt_date: null,
            debt_age_days: null,
            last_activity_at: new Date(Date.now() - 86400000).toISOString(),
            overdue: false,
            archived: false,
            created_at: date,
            updated_at: date,
          });
          getMockDb().debtEntries.push({
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            customer_id: id,
            kind: 'credit_sale',
            amount: 1250000,
            balance_after: 1250000,
            sale_id: null,
            method: null,
            reason: null,
            business_date: '2026-10-26',
            created_at: '2026-10-26T11:40:00Z',
          });
        }
        if (route === 'customer') route = `customer/${id}`;
      } else if (route === 'index' && state === 'document') {
        setNextScanDocument();
      } else if (route === 'digest' && state === 'populated') {
        setDigestFixture({
          sales: {
            revenue: 1240000,
            sale_count: 32,
            gross_profit: 280000,
            change_pct: 8,
          },
          restock: [
            {
              product_id: PRODUCT_IDS.haohao,
              name: 'Hảo Hảo tôm chua cay',
              quantity: 60,
              stock_quantity: 3,
              sales_rate: 6,
              image_url: 'https://mock.local/haohao.png',
              unit_cost: 50000,
              total_cost: 100000,
            },
          ],
          overdue_debts: { count: 2, total: 2070000 },
        });
      }

      const validStates = [
        'low',
        'cash',
        'credit',
        'matched',
        'unknown',
        'ambiguous',
        'detail',
        'cart',
        'pay',
        'picker',
        'selected',
        'sell',
        'elder',
        'product',
        'units',
        'export',
        'populated',
        'edit',
        'summary',
        'seeded',
        'document',
        'close',
        'listening',
        'draft',
        'understanding',
        'response',
      ];
      if (
        !/^[a-z0-9/-]+$/.test(route) ||
        (state && !validStates.includes(state))
      ) {
        throw new Error(`Unsupported route/state: ${target}`);
      }
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        permissions: ['camera', 'microphone'],
      });
      try {
        await setup(
          page,
          route === 'sign-in',
          route === 'welcome',
          route === 'voice' && state === 'understanding',
        );
        if (route === 'inventory' && state === 'elder') {
          await page.addInitScript(() =>
            localStorage.setItem(
              'taphoa-settings',
              JSON.stringify({
                state: {
                  elderMode: true,
                  speakTotal: true,
                  fontScale: 1,
                  language: 'vi',
                },
                version: 2,
              }),
            ),
          );
        }
        if (
          route === 'index' &&
          [
            'matched',
            'unknown',
            'ambiguous',
            'cart',
            'pay',
            'picker',
            'selected',
          ].includes(state)
        ) {
          await page.route('**/v1/recognition/scans', (r) =>
            r.fulfill({
              status: 201,
              json: {
                id: '018c0000-0000-7000-8000-000000000001',
                image: {
                  id: '018c0000-0000-7000-8000-000000000002',
                  url: 'https://example.test/x.jpg',
                  width: 1280,
                  height: 1280,
                },
                mode: 'single',
                purpose: 'checkout',
                pipeline: { segmenter: 'sam', embedder: 'dino' },
                detections: [
                  {
                    id: '018c0000-0000-7000-8000-000000000003',
                    bbox: [300, 400, 680, 520],
                    score: 0.95,
                    match: ['unknown', 'ambiguous'].includes(state)
                      ? state
                      : 'matched',
                    candidates:
                      state === 'unknown'
                        ? []
                        : [
                            {
                              product_id:
                                '00000000-0000-4000-8000-0000000003e8',
                              name: 'Coca-Cola lon 330ml',
                              thumbnail_url: 'https://mock.local/coca.png',
                              price: 10000,
                              similarity: state === 'ambiguous' ? 0.74 : 0.96,
                            },
                            {
                              product_id: 'p2',
                              name: 'Coca-Cola',
                              price: 12000,
                              similarity: 0.7,
                            },
                          ],
                  },
                ],
                created_at: new Date().toISOString(),
              },
            }),
          );
        }
        const entryRoute =
          requestedRoute === 'receipt'
            ? 'receipts'
            : requestedRoute === 'customer'
              ? 'debts'
              : requestedRoute === 'stock'
                ? 'inventory?segment=stock'
                : route;
        const query =
          route === 'enroll' && state === 'populated'
            ? `?${new URLSearchParams({
                photoUri: `${process.env.DESIGN_AUDIT_BOARD_URL || 'http://127.0.0.1:4175'}/docs/design/canvas/img/oreo.jpg`,
                price: '15000',
              })}`
            : route === 'voice' && state
              ? '?fixture=two-line-sale.m4a'
              : '';
        await page.goto(
          `${base}/${entryRoute === 'index' ? '' : entryRoute}${query}`,
          {
            waitUntil: 'domcontentloaded',
          },
        );
        await page.waitForTimeout(5000); // Allow auth, fixture queries, and route animations to settle.
        if (route === 'welcome') {
          await page.getByText('Tạo cửa hàng', { exact: true }).waitFor();
        } else if (requestedRoute === 'receipt') {
          await page.getByText('Bản nháp', { exact: false }).first().click();
          await page.waitForTimeout(2000);
        } else if (requestedRoute === 'customer') {
          await page.getByText('Chị Lan', { exact: true }).first().click();
          await page.waitForTimeout(2000);
        }
        const expectedPath =
          route === 'index'
            ? '/'
            : requestedRoute === 'stock'
              ? '/inventory'
              : requestedRoute === 'receipt'
                ? '/receipts'
                : `/${route}`;
        if (new URL(page.url()).pathname !== expectedPath)
          throw new Error(`Expected ${expectedPath}, got ${page.url()}`);
        if (
          await page.getByText('Màn hình gặp lỗi', { exact: true }).isVisible()
        )
          throw new Error(`Route ${expectedPath} displayed the error boundary`);
        if (
          [
            'matched',
            'unknown',
            'ambiguous',
            'cart',
            'pay',
            'picker',
            'selected',
          ].includes(state) &&
          route === 'index'
        ) {
          await page.getByRole('button', { name: 'Chụp', exact: true }).click();
          await page.getByTestId('box-frame').waitFor({ timeout: 15000 });
          if (['cart', 'pay', 'picker', 'selected'].includes(state)) {
            await page
              .getByRole('button', { name: 'Thêm vào giỏ', exact: true })
              .click();
            await page.getByRole('button', { name: /^Giỏ hàng:/ }).click();
            await page.getByTestId('cart-sheet').waitFor();
            if (state !== 'cart') {
              await page
                .getByRole('button', { name: 'Hiện mã QR thanh toán' })
                .click();
              await page.getByRole('radio', { name: /Chuyển khoản/ }).waitFor();
              if (['picker', 'selected'].includes(state)) {
                await page.getByRole('radio', { name: /Ghi nợ/ }).click();
                if (state === 'selected')
                  await page
                    .getByRole('button', { name: /Chị Lan/ })
                    .first()
                    .click();
              }
            }
            await page.waitForTimeout(1000);
          }
        } else if (requestedRoute === 'index' && state === 'document') {
          await page.getByRole('button', { name: 'Chụp', exact: true }).click();
        } else if (state === 'detail' && route === 'sales') {
          await page
            .getByRole('button')
            .filter({ hasText: /đ/ })
            .first()
            .click();
          await page.waitForTimeout(2000);
        } else if (state === 'low' && route === 'stock') {
          await page.getByRole('button', { name: 'Lọc tồn kho' }).click();
          await page.getByRole('radio', { name: 'Sắp hết' }).click();
          await page.waitForTimeout(1000);
        } else if (state === 'cash' && route === 'pay') {
          await page.getByRole('radio', { name: /Tiền mặt/ }).click();
        } else if (state === 'credit' && route === 'pay') {
          await page.getByRole('radio', { name: /Ghi nợ/ }).click();
        } else if (route === 'inventory' && ['sell', 'elder'].includes(state)) {
          const add = page
            .getByRole('button', { name: /^Thêm .+ vào giỏ$/ })
            .first();
          await add.click();
          await add.click();
        } else if (
          route === 'inventory' &&
          ['product', 'units'].includes(state)
        ) {
          await page
            .getByRole('button', { name: /^Coca-Cola lon 330ml, / })
            .click();
          await page.getByRole('button', { name: 'Sửa đơn vị bán' }).waitFor();
          if (state === 'units') {
            await page.getByRole('button', { name: 'Sửa đơn vị bán' }).click();
            await page
              .getByTestId('units-page')
              .getByRole('button', { name: 'Sửa đơn vị thùng' })
              .click();
          }
        } else if (route === 'dashboard' && state === 'export') {
          await page.getByRole('button', { name: 'Xuất giao dịch' }).click();
        } else if (requestedRoute === 'dashboard' && state === 'close') {
          await page
            .getByRole('button', { name: 'Chốt sổ', exact: true })
            .click();
          await page.waitForTimeout(1000);
        } else if (requestedRoute === 'receipt' && state === 'summary') {
          // In X3, receipts flow is unified and review is direct; no "Xong, xem lại" step.
        } else if (route === 'enroll' && state === 'populated') {
          await page.getByLabel('1 trên 5 ảnh').waitFor();
        } else if (route === 'assistant' && state === 'response') {
          await page
            .getByTestId('assistant-input')
            .fill('Hôm nay bán được bao nhiêu?');
          await page.getByTestId('assistant-send').click();
          await page
            .getByText(/1.234.000/)
            .first()
            .waitFor();
        } else if (route === 'voice' && state === 'draft') {
          await page.getByLabel('Xong, hiểu lời vừa nói').click();
          await page.getByTestId('voice-total').waitFor();
        } else if (route === 'voice' && state === 'understanding') {
          await page.getByLabel('Xong, hiểu lời vừa nói').click();
          await page.getByTestId('voice-understanding').waitFor();
        } else if (route === 'voice' && state === 'listening') {
          await page.getByLabel('Xong, hiểu lời vừa nói').waitFor();
        } else if (
          (requestedRoute === 'receipt' && state === 'edit') ||
          (requestedRoute === 'digest' && state === 'populated') ||
          (['customer', 'debts'].includes(requestedRoute) && state === 'seeded')
        ) {
          if (requestedRoute === 'digest' && state === 'populated') {
            await page.getByText('2 thùng').waitFor({ timeout: 5000 });
          }
          // The fixture-backed route already represents the requested state.
        } else if (state) {
          throw new Error(`State ${state} is not supported for ${route}`);
        }
        await page.waitForTimeout(1000);
        const name = `${requestedRoute.replaceAll('/', '-')}${state ? `-${state}` : ''}`;
        await page.screenshot({ path: path.join(output, `seed-${name}.png`) });
        await page.setViewportSize({ width: 390, height: 1240 });
        await page.screenshot({
          path: path.join(output, `seed-${name}-tall.png`),
          fullPage: true,
        });
        console.log(`${target}: ${page.url()}`);
      } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
