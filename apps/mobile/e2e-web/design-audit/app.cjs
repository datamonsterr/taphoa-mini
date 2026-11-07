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
    // The test mock does not implement sync; preserve its 404, which the app tolerates.
    const headers = {
      ...request.headers(),
      authorization: 'Bearer mock-token',
    };
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
            'listening',
            'draft',
            'understanding',
            'response',
          ].includes(state))
      )
        throw new Error(`Unsupported route/state: ${target}`);
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
        await page.goto(
          `${base}/${route === 'index' ? '' : route}${route === 'voice' && state ? '?fixture=two-line-sale.m4a' : ''}`,
          {
            waitUntil: 'domcontentloaded',
          },
        );
        await page.waitForTimeout(5000); // Allow auth, fixture queries, and route animations to settle.
        if (route === 'welcome')
          await page.getByText('Tạo cửa hàng', { exact: true }).waitFor();
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
        else if (route === 'assistant' && state === 'response') {
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
        } else if (state)
          throw new Error(`State ${state} is not supported for ${route}`);
        const name = `${route.replaceAll('/', '-')}${state ? `-${state}` : ''}`;
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
