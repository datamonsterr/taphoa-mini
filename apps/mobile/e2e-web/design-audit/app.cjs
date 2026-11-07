const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { repo, output, launchOptions } = require('./common.cjs');
const mockFetch = require('./mock-loader.cjs');

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
      const route = rawRoute.replace(/^\//, '') || 'index';
      if (
        !/^[a-z0-9/-]+$/.test(route) ||
        (state &&
          ![
            'low',
            'cash',
            'credit',
            'sell',
            'elder',
            'product',
            'units',
            'export',
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
        if (route === 'inventory' && state === 'elder')
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
        const query =
          route === 'enroll' && state === 'populated'
            ? `?${new URLSearchParams({ photoUri: `${process.env.DESIGN_AUDIT_BOARD_URL || 'http://127.0.0.1:4175'}/docs/design/canvas/img/oreo.jpg`, price: '15000' })}`
            : '';
        await page.goto(`${base}/${route === 'index' ? '' : route}${query}`, {
          waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(5000); // Allow auth, fixture queries, and route animations to settle.
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
        else if (route === 'inventory' && ['sell', 'elder'].includes(state)) {
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
        } else if (route === 'dashboard' && state === 'export')
          await page.getByRole('button', { name: 'Xuất giao dịch' }).click();
        else if (route === 'enroll' && state === 'populated') {
          await page.getByLabel('1 trên 5 ảnh').waitFor();
        } else if (state)
          throw new Error(`State ${state} is not supported for ${route}`);
        await page.waitForTimeout(1000); // Let route and modal transitions finish.
        const name = `${route.replaceAll('/', '-')}${state ? `-${state}` : ''}`;
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
