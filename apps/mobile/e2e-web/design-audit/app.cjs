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
  await mockFetch('http://localhost:8080/v1/customers', {
    method: 'POST',
    headers: {
      authorization: 'Bearer mock-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: '00000000-0000-4000-8000-000000001234',
      name: 'Chị Lan',
      phone: '0912345678',
    }),
  });
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
            'matched',
            'unknown',
            'ambiguous',
            'detail',
            'cart',
            'pay',
            'picker',
            'selected',
          ].includes(state))
      )
        throw new Error(`Unsupported route/state: ${target}`);
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        permissions: ['camera', 'microphone'],
      });
      try {
        await setup(page, route === 'sign-in');
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
        await page.goto(`${base}/${route === 'index' ? '' : route}`, {
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
                  await page.getByRole('button', { name: /Chị Lan/ }).click();
              }
            }
            await page.waitForTimeout(1000);
          }
        } else if (state === 'detail' && route === 'sales') {
          await page
            .getByRole('button')
            .filter({ hasText: /đ/ })
            .first()
            .click();
          await page.waitForTimeout(2000);
        } else if (state === 'low' && route === 'stock')
          await page
            .getByRole('button', { name: 'Sắp hết', exact: true })
            .click();
        else if (state === 'cash' && route === 'pay')
          await page.getByRole('radio', { name: /Tiền mặt/ }).click();
        else if (state === 'credit' && route === 'pay')
          await page.getByRole('radio', { name: /Ghi nợ/ }).click();
        else if (state)
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
