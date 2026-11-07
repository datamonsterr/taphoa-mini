const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { repo, output, launchOptions } = require('./common.cjs');
const mockFetch = require('./mock-loader.cjs');
const { registerImage, getMockDb } = require('../../src/test/mock/db.ts');
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

async function setup(page, signedOut) {
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
  const browser = await chromium.launch(launchOptions());
  try {
    for (const target of targets) {
      const [rawRoute, state] = target.split(':');
      let route = rawRoute.replace(/^\//, '') || 'index';
      const requestedRoute = route;
      if (route === 'receipt' && ['edit', 'summary'].includes(state)) {
        const image = registerImage({ contentType: 'image/jpeg', byteSize: 1 });
        route = `receipt/${createReceipt(image.id).id}`;
      } else if (['customer', 'debts'].includes(route) && state === 'seeded') {
        const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const date = new Date().toISOString();
        getMockDb().customers.push({
          id,
          name: 'Chị Lan',
          phone: '0912345678',
          note: null,
          credit_limit: 5000000,
          balance: 1250000,
          oldest_debt_date: null,
          debt_age_days: null,
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
        if (route === 'customer') route = `customer/${id}`;
      } else if (route === 'index' && state === 'document')
        setNextScanDocument();
      else if (route === 'digest' && state === 'populated')
        setDigestFixture({
          sales: {
            revenue: 1240000,
            sale_count: 32,
            gross_profit: 280000,
            change_pct: 8,
          },
          restock: [
            {
              product_id: 'p-haohao',
              name: 'Hảo Hảo tôm chua cay',
              quantity: 2,
              unit_cost: 50000,
              total_cost: 100000,
            },
          ],
          overdue_debts: { count: 2, total: 2070000 },
        });
      if (
        !/^[a-z0-9/-]+$/.test(route) ||
        (state &&
          ![
            'low',
            'cash',
            'credit',
            'edit',
            'summary',
            'seeded',
            'document',
            'close',
            'populated',
          ].includes(state))
      )
        throw new Error(`Unsupported route/state: ${target}`);
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        permissions: ['camera', 'microphone'],
      });
      try {
        await setup(page, route === 'sign-in');
        const entryRoute =
          requestedRoute === 'receipt'
            ? 'receipts'
            : requestedRoute === 'customer'
              ? 'debts'
              : route;
        await page.goto(`${base}/${entryRoute === 'index' ? '' : entryRoute}`, {
          waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(5000); // Allow auth, fixture queries, and route animations to settle.
        if (requestedRoute === 'receipt') {
          await page.getByText('Bản nháp', { exact: false }).first().click();
          await page.waitForTimeout(2000);
        } else if (requestedRoute === 'customer') {
          await page.getByText('Chị Lan', { exact: true }).click();
          await page.waitForTimeout(2000);
        }
        const expectedPath = route === 'index' ? '/' : `/${route}`;
        if (new URL(page.url()).pathname !== expectedPath)
          throw new Error(`Expected ${expectedPath}, got ${page.url()}`);
        if (
          await page.getByText('Màn hình gặp lỗi', { exact: true }).isVisible()
        )
          throw new Error(`Route ${expectedPath} displayed the error boundary`);
        if (state === 'low' && route === 'stock')
          await page
            .getByRole('button', { name: 'Sắp hết', exact: true })
            .click();
        else if (state === 'cash' && route === 'pay')
          await page.getByRole('radio', { name: /Tiền mặt/ }).click();
        else if (state === 'credit' && route === 'pay')
          await page.getByRole('radio', { name: /Ghi nợ/ }).click();
        else if (requestedRoute === 'receipt' && state === 'summary')
          await page.getByRole('button', { name: 'Xong, xem lại' }).click();
        else if (requestedRoute === 'index' && state === 'document')
          await page.getByRole('button', { name: 'Chụp', exact: true }).click();
        else if (requestedRoute === 'dashboard' && state === 'close') {
          await page
            .getByRole('button', { name: 'Chốt sổ', exact: true })
            .click();
          await page.waitForTimeout(1000);
        } else if (
          (requestedRoute === 'receipt' && state === 'edit') ||
          (requestedRoute === 'digest' && state === 'populated') ||
          (['customer', 'debts'].includes(requestedRoute) && state === 'seeded')
        ) {
          // The fixture-backed route already represents the requested state.
        } else if (state)
          throw new Error(`State ${state} is not supported for ${route}`);
        const name = `${requestedRoute.replaceAll('/', '-')}${state ? `-${state}` : ''}`;
        await page.screenshot({ path: path.join(output, `seed-${name}.png`) });
        await page.setViewportSize({ width: 390, height: 1240 });
        await page.screenshot({
          path: path.join(output, `seed-${name}-tall.png`),
          fullPage: true,
        });
        console.log(`${target}: ${page.url()}`);
      } finally {
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
