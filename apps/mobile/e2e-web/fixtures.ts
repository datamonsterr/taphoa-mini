/* eslint-disable react-hooks/rules-of-hooks, no-empty-pattern -- Playwright fixtures call `use`, which is not a React hook, and destructure nothing */
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';

import { formatVnd } from '../src/lib/format';
import {
  createClerkUser,
  deleteTestUsers,
  signInPage,
  type TestUser,
} from './clerk-auth';

export { TEST_CODE, deleteClerkUsersByEmail, uniqueEmail } from './clerk-auth';
export type { TestUser } from './clerk-auth';

/**
 * Every spec here drives the real UI against the real backend (scripts/e2e/stack.sh): a tap makes
 * a real HTTP request, the backend answers, the screen shows the answer. Nothing intercepts or
 * fakes an API call; the specs only observe them (`callApi`, `waitForApi`) and compare the UI
 * with what the response said.
 *
 * Identity is real too: every store belongs to a Clerk user of the development instance, created
 * through the Clerk Backend API (clerk-auth.ts). The node side calls the backend with that user's
 * session token; the browser signs in as the same user with the `@clerk/testing` helper, so the app
 * runs its own Clerk session and sends its own bearer and `X-Store-Id`.
 */

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080'
).replace(/\/$/, '');

export { formatVnd };

// ---- API (node side): seeding and reading back ------------------------------------------

type Json = Record<string, any>;

/** A catalog product as the API returns it (only the fields the specs rely on are typed). */
export type Product = {
  id: string;
  name: string;
  price: number;
  cost_price?: number | null;
  [field: string]: any;
};

/** A Clerk user's membership in one store, with the bearer the node side calls the API with. */
export type Session = {
  /** Clerk session token (one hour). */
  access_token: string;
  member: Json;
  store: Json;
  clerk_user_id: string;
  email: string;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    what: string,
  ) {
    super(`${what} answered ${status}: ${JSON.stringify(body)}`);
  }
}

/** Plain `fetch` to the backend with an optional bearer token. */
export async function http<T = any>(
  method: string,
  route: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
  const response = await fetch(`${API_URL}${route}`, {
    method,
    headers: {
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!response.ok)
    throw new ApiError(response.status, parsed, `${method} ${route}`);
  return parsed as T;
}

/** A signed-in client for seeding a store and reading the truth back from the server. */
export class Api {
  constructor(readonly session: Session) {}

  get token() {
    return this.session.access_token;
  }

  /** The store the token's user acts in (required by the API once a user has several stores). */
  private get headers(): Record<string, string> {
    return { 'x-store-id': String(this.session.store.id) };
  }

  get = <T = any>(route: string) =>
    http<T>('GET', route, { token: this.token, headers: this.headers });
  post = <T = any>(
    route: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) =>
    http<T>('POST', route, {
      token: this.token,
      body,
      headers: { ...this.headers, ...headers },
    });
  put = <T = any>(route: string, body?: unknown) =>
    http<T>('PUT', route, {
      token: this.token,
      body,
      headers: this.headers,
    });
  patch = <T = any>(route: string, body?: unknown) =>
    http<T>('PATCH', route, {
      token: this.token,
      body,
      headers: this.headers,
    });

  /** Product creation is asynchronous: a scan must wait for real embeddings. */
  async waitForIndex(id: string) {
    await expect
      .poll(async () => (await this.get(`/v1/products/${id}`)).index_status, {
        timeout: 60_000,
        message: `product ${id} finishes indexing`,
        intervals: [250, 500, 1000],
      })
      .toBe('ready');
  }

  /** POST /v1/images (multipart) with a fixture photo; returns the image id. */
  async uploadImage(file = PHOTO, purpose = 'enrollment'): Promise<string> {
    const form = new FormData();
    form.append(
      'image',
      new Blob([readFileSync(file)], { type: 'image/jpeg' }),
      'photo.jpg',
    );
    form.append('purpose', purpose);
    const response = await fetch(`${API_URL}/v1/images`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, ...this.headers },
      body: form,
    });
    const body = (await response.json()) as Json;
    if (!response.ok)
      throw new ApiError(response.status, body, 'POST /v1/images');
    return body.id as string;
  }

  /** Creates a catalog product through the API (`force_new`: seeded photos may look alike). */
  async createProduct(input: {
    name: string;
    price: number;
    cost_price?: number;
    /** Photo to enroll; `PRODUCT_PHOTO` makes it what the fake camera shows. */
    photo?: string;
  }): Promise<Product> {
    const { photo, ...product } = input;
    const image_ids = [await this.uploadImage(photo)];
    return withScanSlot(() =>
      this.post('/v1/products', {
        id: uuid7(),
        image_ids,
        force_new: true,
        ...product,
      }),
    );
  }

  /** Records an expense (cash box) today; purchase lines raise stock and may set the cost. */
  createExpense(input: {
    amount: number;
    category?: 'nhap_hang' | 'dien' | 'nuoc' | 'khac';
    purchase_lines?: {
      product_id: string;
      quantity: number;
      unit_cost: number;
    }[];
  }): Promise<Json> {
    return this.post('/v1/expenses', {
      id: uuid7(),
      spent_at: new Date().toISOString(),
      category: 'khac',
      paid_with: 'cash_box',
      ...input,
    });
  }

  /** Sets the VietQR bank account of the store. */
  setBank(bank: Json = BANK): Promise<Json> {
    return this.patch('/v1/store', { bank_account: bank });
  }

  /** Records a cash sale of catalog products and/or manually priced lines. */
  async createSale(input: {
    lines: (
      | { product_id: string; unit_price: number; quantity?: number }
      | { manual_label: string; unit_price: number; quantity?: number }
    )[];
    payment_method?: 'cash' | 'transfer';
  }): Promise<Json> {
    const lines = input.lines.map((line) => ({
      id: uuid7(),
      source: 'product_id' in line ? 'grid' : 'manual',
      quantity: 1,
      ...line,
    }));
    const total = lines.reduce((sum, l) => sum + l.unit_price * l.quantity, 0);
    const id = uuid7();
    return this.post(
      '/v1/sales',
      {
        id,
        sold_at: new Date().toISOString(),
        payment_method: input.payment_method ?? 'cash',
        ...((input.payment_method ?? 'cash') === 'cash'
          ? { cash_received: total }
          : {}),
        total,
        lines,
      },
      { 'Idempotency-Key': id },
    );
  }
}

/** A photo for seeded products that are never scanned (the backend's shelf fixture). */
export const PHOTO = path.join(
  __dirname,
  '../../backend/tests/fixtures/shelf-1600.jpg',
);

/**
 * The still behind the fake camera (written by fixtures/make-video.sh). A product seeded with it
 * is what a scan of the camera picture matches.
 */
export const PRODUCT_PHOTO = path.join(__dirname, 'fixtures/product.jpg');

/** UUID v7 like the app's own ids (the backend rejects other versions for sale ids). */
export function uuid7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1)
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The bank account the pay screen draws a VietQR for. */
export const BANK = {
  bank_bin: '970436',
  bank_short_name: 'VCB',
  account_number: '0123456789',
  account_name: 'NGUYEN THI BA',
} as const;

/** The session of a Clerk user from the answer to POST /v1/stores or /v1/auth/join. */
function sessionOf(
  user: TestUser,
  membership: { member: Json; store: Json },
): Session {
  return {
    access_token: user.token,
    member: membership.member,
    store: membership.store,
    clerk_user_id: user.userId,
    email: user.email,
  };
}

/** POST /v1/stores: a new Clerk user becomes the Lead of an empty store. */
export async function createStoreViaApi(
  storeName = `Tạp hóa E2E ${crypto.randomUUID().slice(0, 8)}`,
  displayName = 'Cô Ba',
): Promise<StoreFixture> {
  const user = await createClerkUser();
  const body = await http('POST', '/v1/stores', {
    token: user.token,
    body: { store_name: storeName, display_name: displayName },
  });
  const session = sessionOf(user, body);
  return { session, api: new Api(session), user };
}

/** The Lead invites a seller; a new Clerk user redeems the invite through POST /v1/auth/join. */
export async function joinStoreViaApi(
  lead: Api,
  displayName = 'Bé Út',
): Promise<StoreFixture & { invite: Json }> {
  const invite = await lead.post('/v1/invites', {
    role: 'seller',
    can_enroll: false,
    ttl_seconds: 600,
  });
  const user = await createClerkUser();
  const body = await http('POST', '/v1/auth/join', {
    token: user.token,
    body: { invite_token: invite.token, display_name: displayName },
  });
  const session = sessionOf(user, body);
  return { session, api: new Api(session), user, invite };
}

/** A Clerk user with no store yet: signing in lands on the welcome screen. */
export const createNewcomer = () => createClerkUser();

// ---- Playwright fixtures ---------------------------------------------------------------

type StoreFixture = {
  session: Session;
  api: Api;
  user: TestUser;
};

type Fixtures = {
  /** Deletes the Clerk users the test created as soon as it ends (see clerk-auth.ts). */
  clerkCleanup: void;
  consoleGuard: void;
  /** Creates the test's store once, on first use (`store` and the signed-in `page` share it). */
  storeFactory: () => Promise<StoreFixture>;
  /**
   * A fresh store created through the API (a new Clerk user is its Lead), so every test owns its
   * data and tests stay parallel safe. Unless `signedIn` is switched off, `page` starts signed in
   * to it. The onboarding spec creates its stores and users through the sign-in screens.
   */
  store: StoreFixture;
};

type Options = {
  /** Signs the page in as the Lead of `store` before the test body (default). */
  signedIn: boolean;
};

/** The API client of the user a page was signed in as (for specs that wait on server state). */
const apiOfPage = new WeakMap<Page, Api>();

/** The shop home: only a signed-in member with a store sees it. */
export const shopHome = (page: Page) =>
  page.getByRole('button', { name: 'Chụp', exact: true });

/** The screen of a signed-in user without a store. */
export const welcomeScreen = (page: Page) =>
  page.getByTestId('onboarding-welcome-screen');

/** The first screen of a signed-out visitor. */
export const signInScreen = (page: Page) =>
  page.getByTestId('auth-sign-in-screen');

/**
 * Signs `page` in as `user` through Clerk (no typing) and waits for the screen the account
 * lands on: the shop for a member, the welcome screen for a user without a store.
 */
export async function signInAs(
  page: Page,
  user: { email: string },
  api?: Api,
): Promise<void> {
  await signInPage(page, user.email);
  if (api) apiOfPage.set(page, api);
  await expect(shopHome(page).or(welcomeScreen(page))).toBeVisible({
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);
}

/**
 * A second browser (own cookies and storage) signed in as `user`: another phone. The caller
 * closes the context.
 */
export async function openSignedInPhone(
  browser: Browser,
  baseURL: string | undefined,
  user: { email: string },
  api?: Api,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    permissions: ['camera'],
    viewport: { width: 390, height: 844 },
  });
  try {
    await trackApiBodies(context);
    const page = await context.newPage();
    await signInAs(page, user, api);
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** Failed requests that are not problems: a navigation aborts what was still in flight. */
const benignFailure = (error: string | undefined) =>
  error === 'net::ERR_ABORTED' || error === 'NS_BINDING_ABORTED';

const CLIENT_ERROR_LOG =
  /^Failed to load resource: the server responded with a status of 4\d\d/;

export const test = base.extend<Fixtures & Options>({
  signedIn: [true, { option: true }],
  // Set up first, torn down last: the browser contexts are closed before their users go.
  clerkCleanup: [
    async ({}, use) => {
      await use();
      await deleteTestUsers();
    },
    { auto: true, timeout: 120_000 },
  ],
  storeFactory: async ({}, use) => {
    let made: Promise<StoreFixture> | undefined;
    await use(() => (made ??= createStoreViaApi()));
  },
  store: async ({ storeFactory }, use) => {
    await use(await storeFactory());
  },
  context: async ({ context }, use) => {
    await trackApiBodies(context);
    await use(context);
  },
  // The browser signs in as the Lead of `store` with Clerk's own session (clerk-auth.ts), the
  // way a phone does after the sign-in screens; nothing is written to storage by hand.
  page: [
    async ({ page, signedIn, storeFactory }, use) => {
      if (signedIn) {
        const { user, api } = await storeFactory();
        await signInAs(page, user, api);
      }
      await use(page);
    },
    // Creating the user, the store and the Clerk session takes seconds and may back off:
    // that is setup, not test time.
    { scope: 'test', timeout: 120_000 },
  ],
  consoleGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on('pageerror', (error) =>
        problems.push(`pageerror: ${error.message}`),
      );
      page.on('requestfailed', (request) => {
        if (!benignFailure(request.failure()?.errorText))
          problems.push(
            `requestfailed: ${request.url().slice(0, 120)} ${request.failure()?.errorText}`,
          );
      });
      page.on('console', (message) => {
        // The browser logs every 4xx answer; a spec that provokes one asserts the status itself.
        if (
          message.type() === 'error' &&
          !CLIENT_ERROR_LOG.test(message.text())
        )
          problems.push(`console.error: ${message.text()}`);
      });
      await use();
      expect(problems, 'browser errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Records the body of every fetch the app makes (observation only: the call goes through
 * untouched). `callApi` reads the record back so a spec can assert what the app sent.
 */
export async function trackApiBodies(context: BrowserContext) {
  await context.addInitScript((apiUrl: string) => {
    const log: { method: string; url: string; body: unknown }[] = [];
    (window as any).__apiBodies = log;
    const original = window.fetch;
    const parse = (text: string) => {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return text;
      }
    };
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      try {
        const request = input instanceof Request ? input : null;
        const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
        const entry = {
          method,
          url: request
            ? request.url
            : new URL(String(input), location.href).href,
          body: null as unknown,
        };
        // Only the backend's calls: Clerk's own Frontend API traffic is not the specs' business.
        if (!entry.url.startsWith(apiUrl))
          return original.apply(this, [input, init] as never);
        log.push(entry);
        const type = request?.headers.get('content-type') ?? '';
        if (request && type.includes('multipart')) {
          void request
            .clone()
            .formData()
            .then((form) => {
              const fields: Record<string, unknown> = {};
              (
                form as unknown as {
                  forEach(
                    callback: (value: FormDataEntryValue, key: string) => void,
                  ): void;
                }
              ).forEach((value, key) => {
                fields[key] =
                  typeof value === 'string'
                    ? value
                    : { file: value.name, type: value.type, size: value.size };
              });
              entry.body = { multipart: fields };
            });
        } else if (request && request.body) {
          void request
            .clone()
            .text()
            .then((text) => {
              entry.body = parse(text);
            });
        } else if (typeof init?.body === 'string') {
          entry.body = parse(init.body);
        }
      } catch {
        // observing must never break the app
      }
      return original.apply(this, [input, init] as never);
    };
  }, API_URL);
}

// ---- observing API traffic -------------------------------------------------------------

export type ApiCall<T = any> = {
  method: string;
  path: string;
  status: number;
  /** Parsed JSON body; for multipart `{ multipart: { field: value | { file, type, size } } }`. */
  requestBody: any;
  requestHeaders: Record<string, string>;
  /** Parsed JSON answer (null for 204). */
  body: T;
};

const matches = (pattern: string | RegExp, actual: string) =>
  typeof pattern === 'string' ? pattern === actual : pattern.test(actual);

function isCall(
  response: Response,
  method: string,
  pattern: string | RegExp,
): boolean {
  const request = response.request();
  if (request.method() !== method) return false;
  if (!response.url().startsWith(API_URL)) return false;
  return matches(pattern, new URL(response.url()).pathname);
}

async function describeCall<T>(response: Response): Promise<ApiCall<T>> {
  const request: Request = response.request();
  const url = response.url();
  // The app sends bodies as streams, which the browser does not hand back to Playwright: read
  // them from the observer that `trackApiBodies` installs (it only records, never alters).
  const requestBody = ['GET', 'HEAD'].includes(request.method())
    ? null
    : await request
        .frame()
        .page()
        .evaluate(
          ([method, href]) => {
            const log = ((window as any).__apiBodies ?? []) as {
              method: string;
              url: string;
              body: unknown;
            }[];
            return (
              [...log]
                .reverse()
                .find((e) => e.method === method && e.url === href)?.body ??
              null
            );
          },
          [request.method(), url],
        );
  const text = response.status() === 204 ? '' : await response.text();
  return {
    method: request.method(),
    path: new URL(url).pathname,
    status: response.status(),
    requestBody,
    requestHeaders: request.headers(),
    body: (text ? JSON.parse(text) : null) as T,
  };
}

/**
 * Resolves with the next response of `METHOD path` the page receives. Start it BEFORE the tap
 * that triggers the call (or use `callApi`), never after.
 */
export async function waitForApi<T = any>(
  page: Page,
  method: string,
  route: string | RegExp,
  expectedStatus: number | 'ok' = 'ok',
): Promise<ApiCall<T>> {
  const response = await page.waitForResponse((r) => isCall(r, method, route), {
    timeout: 30_000,
  });
  const call = await describeCall<T>(response);
  if (expectedStatus === 'ok')
    expect(
      call.status,
      `${method} ${route} answered ${call.status}: ${JSON.stringify(call.body)}`,
    ).toBeLessThan(300);
  else expect(call.status).toBe(expectedStatus);
  return call;
}

/** Collects every response of `METHOD path` from now until `stop()` (for calls that repeat). */
export function recordApi(page: Page, method: string, route: string | RegExp) {
  const pending: Promise<ApiCall>[] = [];
  const onResponse = (response: Response) => {
    if (isCall(response, method, route)) pending.push(describeCall(response));
  };
  page.on('response', onResponse);
  return {
    async stop() {
      page.off('response', onResponse);
      return Promise.all(pending);
    },
  };
}

/** Runs the UI `action` and returns the API call it caused. */
export async function callApi<T = any>(
  page: Page,
  method: string,
  route: string | RegExp,
  action: () => Promise<unknown>,
  expectedStatus: number | 'ok' = 'ok',
): Promise<ApiCall<T>> {
  const [call] = await Promise.all([
    waitForApi<T>(page, method, route, expectedStatus),
    action(),
  ]);
  return call;
}

// ---- UI helpers ----------------------------------------------------------------------------

export const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole('button', { name, exact: typeof name === 'string' });

/** Waits for fonts and the first screen landmark; never sleeps. */
export async function hydrate(page: Page, landmark: Locator) {
  await expect(landmark).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** The app's money format ("12.000đ") for an amount taken from an API response. */
export const money = formatVnd;

/** Asserts the locator's text contains `amount` formatted like the app does. */
export async function expectMoney(
  locator: Locator,
  amount: number,
  prefix = '',
) {
  await expect(locator).toContainText(`${prefix}${formatVnd(amount)}`);
}

/** Last number in a text, dots read as thousands separators: "Coca 330ml 10.000đ" gives 10000. */
export const vnd = (text: string) => {
  const numbers = text.match(/\d[\d.]*/g) ?? [];
  return Number((numbers.at(-1) ?? '').replace(/\./g, ''));
};

/** Types a number on the keypad ("000" is one key). */
export async function keypad(scope: Page | Locator, keys: string[]) {
  for (const key of keys) await button(scope, key).click();
}

/** Types the digits of an amount on the keypad. */
export const typeAmount = (scope: Page | Locator, amount: number) =>
  keypad(scope, [...String(amount)]);

export async function goShop(page: Page, tab: 'Kho' | 'Báo cáo' | 'Tài khoản') {
  await page.getByRole('tab', { name: tab, exact: true }).click();
}

/** Opens a shop route directly and waits for its landmark and the fonts. */
export async function openShop(
  page: Page,
  path: '/inventory' | '/dashboard' | '/account',
) {
  await page.goto(path);
  await hydrate(page, page.getByRole('tablist', { name: 'Chính' }));
  await expect(
    page.getByRole('tab', { name: 'Kho', exact: true }),
  ).toBeVisible();
}

/** Opens a shop tab and returns the API call that loaded its data. */
export async function openShopLoading<T = any>(
  page: Page,
  path: '/inventory' | '/dashboard' | '/account',
  method: string,
  route: string | RegExp,
): Promise<ApiCall<T>> {
  return callApi<T>(page, method, route, () => openShop(page, path));
}

// ---- camera ------------------------------------------------------------------------------

/**
 * Cuts the network after the page settled: Clerk loads its UI chunks from its CDN a moment after
 * the app is up, and a chunk that fails to load offline is a console error the guard rejects.
 */
export async function goOffline(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.context().setOffline(true);
}

/**
 * Opens routes through the client router so their lazy bundle chunks are downloaded while the
 * network is still up, then returns to `back`. Use before `goOffline` when the test walks screens
 * it has not shown yet: a chunk fetched offline fails with ERR_INTERNET_DISCONNECTED.
 */
export async function warmRoutes(
  page: Page,
  routes: [url: string, landmark: Locator][],
  back: string,
) {
  const go = async (to: string) => {
    await page.evaluate((url) => {
      window.history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, to);
    await page.waitForLoadState('networkidle');
  };
  for (const [url, landmark] of routes) {
    await go(url);
    // networkidle can fire before a lazy chunk is requested: the screen itself proves it loaded
    await expect(landmark).toBeVisible();
  }
  await go(back);
}

export const shutter = (page: Page) => button(page, 'Chụp');
export const enrollTag = (page: Page) => button(page, 'Thêm vào kho với giá');
export const reshoot = (page: Page) => button(page, 'Chụp lại');
export const addButton = (page: Page) =>
  page.getByRole('button', { name: /^Thêm (vào|tất cả vào) giỏ$/ });
export const cartPill = (page: Page) =>
  page.getByRole('button', { name: /^Giỏ hàng/ });
export const detectionBoxes = (page: Page) =>
  page.getByRole('button', { name: /, (đã chọn|bỏ chọn|chưa có trong kho)$/ });

/** Waits until a <video> in the scope plays the fake webcam. */
export async function expectLiveVideo(scope: Page | Locator) {
  const video = scope.locator('video');
  await expect(video).toBeVisible();
  await expect
    .poll(() =>
      video.evaluate(
        (v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth > 0,
      ),
    )
    .toBe(true);
}

/** Opens the camera home and waits for the live preview: the shutter enables once the camera is ready. */
export async function openCamera(page: Page) {
  await page.goto('/');
  await hydrate(page, button(page, 'Chụp'));
  await expect(button(page, 'Chụp')).toBeEnabled();
  await expectLiveVideo(page);
}

/**
 * The backend has ONE inference slot and answers a scan that finds it taken with 503 "segmenter
 * busy" (architecture 5.3). Tests run in parallel workers, so scans take turns through a lock
 * directory shared by the workers. Everything else runs in parallel.
 */
const SCAN_LOCK = path.join(__dirname, 'test-results', 'scan.lock');
const STALE_LOCK_MS = 60_000;

export async function withScanSlot<T>(work: () => Promise<T>): Promise<T> {
  mkdirSync(path.dirname(SCAN_LOCK), { recursive: true });
  for (;;) {
    try {
      mkdirSync(SCAN_LOCK);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        // a crashed worker must not block the others for good
        if (Date.now() - statSync(SCAN_LOCK).mtimeMs > STALE_LOCK_MS)
          rmSync(SCAN_LOCK, { recursive: true, force: true });
      } catch {
        // released meanwhile
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 40 + Math.random() * 60),
      );
    }
  }
  try {
    return await work();
  } finally {
    rmSync(SCAN_LOCK, { recursive: true, force: true });
  }
}

/** Like `callApi`, for a call that runs the models (scan, enroll, add photo): one at a time. */
export const callInference = <T = any>(
  page: Page,
  method: string,
  route: string | RegExp,
  action: () => Promise<unknown>,
  expectedStatus: number | 'ok' = 'ok',
) =>
  withScanSlot(() => callApi<T>(page, method, route, action, expectedStatus));

/**
 * Taps the shutter: the photo is uploaded to the real recognition pipeline (SAM + DINO), and the
 * frozen result shows. Returns the POST /v1/recognition/scans call.
 */
export async function shoot(page: Page, mode: 'single' | 'multi' = 'single') {
  const call = await withScanSlot(() =>
    callApi(page, 'POST', '/v1/recognition/scans', () => shutter(page).click()),
  );
  expect(call.requestBody.multipart).toMatchObject({
    mode,
    purpose: 'checkout',
    image: { type: expect.stringMatching(/^image\/(jpeg|png)$/) },
  });
  await expect(reshoot(page)).toBeVisible();
  await expect(detectionBoxes(page).first()).toBeVisible();
  return call;
}

/** After enrolling the camera may still show the frozen photo: shoot again until it is live. */
export async function backToLive(page: Page) {
  await expect(reshoot(page).or(shutter(page))).toBeVisible();
  if (await reshoot(page).isVisible()) await reshoot(page).click();
  await expect(shutter(page)).toBeEnabled();
}

/** The "?" pill of an unknown detection. */
export const unknownPill = (page: Page) =>
  button(page, 'Chưa có trong kho, nhập giá');

/** The price pill of a matched detection: "<name> <price>, xem món khác". */
export const pricePill = (page: Page) =>
  page.getByRole('button', { name: /xem món khác$/ });

/** The enroll sheet's save button. */
export const saveProduct = (page: Page) =>
  button(page, 'Lưu vào kho và thêm vào giỏ');

/** Names and prices the product being enrolled; waits for the cut-out photo first. */
export async function fillEnroll(
  page: Page,
  product: { name?: string; price: number },
) {
  // the crop is cut in the browser before the photo shows: wait for it
  await expect(page.getByText('1/5')).toBeVisible();
  if (product.name)
    await page
      .getByRole('textbox', { name: 'Tên (không bắt buộc)' })
      .fill(product.name);
  await typeAmount(page, product.price);
  await expect(page.getByLabel('Giá bán', { exact: true })).toHaveText(
    formatVnd(product.price),
  );
  await expect(saveProduct(page)).toBeEnabled();
}

/**
 * Taps save on the enroll sheet and returns the calls it makes: the photo upload(s) and the
 * product creation. Waits until the sheet is gone.
 */
export async function saveEnroll(page: Page, photos = 1) {
  const uploads = recordApi(page, 'POST', '/v1/images');
  const product = await callInference(page, 'POST', '/v1/products', () =>
    saveProduct(page).click(),
  );
  await expect(page).not.toHaveURL(/\/enroll/);
  const images = await uploads.stop();
  expect(images, 'one upload per photo').toHaveLength(photos);
  const api = apiOfPage.get(page);
  if (!api)
    throw new Error('saveEnroll needs a page signed in by the fixtures');
  await api.waitForIndex(product.body.id);
  return { images, product };
}

/**
 * Enrolls the product on the photo: shoot (unknown), open enroll from the "?" pill, name and
 * price it on the keypad, save. Back on the camera with the product in the cart.
 */
export async function enrollFromCamera(
  page: Page,
  product: { name: string; price: number },
) {
  const scan = await shoot(page);
  await unknownPill(page).click();
  await expect(page).toHaveURL(/\/enroll/);
  await fillEnroll(page, product);
  const saved = await saveEnroll(page);
  return { scan, ...saved };
}

/** The product the fake camera shows, seeded through the API: a scan of it is a match. */
export async function seedScannableProduct(
  api: Api,
  product = { name: 'Coca-Cola lon 330ml', price: 10_000, cost_price: 7_500 },
) {
  const created = await api.createProduct({ ...product, photo: PRODUCT_PHOTO });
  await api.waitForIndex(created.id);
  return created;
}

/** Accept one real point-prompted photo of the red pack in product.mjpeg. */
export async function acceptQuickAngle(page: Page) {
  await expectLiveVideo(page);
  const uploaded = await callApi(page, 'POST', '/v1/images', () =>
    shutter(page).click(),
  );
  expect(uploaded.requestBody.multipart.purpose).toBe('enrollment');
  const canvas = page.getByTestId('point-overlay-canvas');
  await expect(canvas).toBeEnabled();
  await expect(button(page, 'Tiếp')).toBeDisabled();
  // The 4:3 fixture has a small logo at its centre. Tap the pack's upper red panel,
  // accounting for the contained photo's letterboxing, so SAM selects the product.
  const bounds = (await canvas.boundingBox())!;
  const photoHeight = Math.min(bounds.width / 4, bounds.height / 3) * 3;
  const segmented = await callInference(
    page,
    'POST',
    '/v1/segment/points',
    () =>
      canvas.click({
        position: {
          x: bounds.width / 2,
          y: bounds.height / 2 - photoHeight / 4,
        },
      }),
  );
  expect(segmented.requestBody).toMatchObject({
    image_id: uploaded.body.id,
    points: [{ x: expect.any(Number), y: expect.any(Number), label: 1 }],
  });
  expect(segmented.body.mask.png_base64).toBeTruthy();
  await expect(page.getByTestId('point-overlay-mask')).toBeVisible();
  await expect(button(page, 'Tiếp')).toBeEnabled();
  await button(page, 'Tiếp').click();
  await expect(canvas).toHaveCount(0);
  return {
    image_id: uploaded.body.id,
    cutout_image_id: segmented.body.cutout_image_id,
    bbox: segmented.body.bbox,
  };
}

/**
 * Shoot, check the server matched the seeded product, tap + : the line is in the cart.
 * Returns the scan call.
 */
export async function scanAndAdd(
  page: Page,
  product: { id: string; name: string; price: number },
) {
  const scan = await shoot(page);
  const detection = scan.body.detections[0];
  expect(detection.match).toBe('matched');
  expect(detection.candidates[0].product_id).toBe(product.id);
  await expect(pricePill(page)).toHaveAccessibleName(
    `${product.name} ${formatVnd(product.price)}, xem món khác`,
  );
  await addButton(page).click();
  await expect(shutter(page)).toBeVisible();
  return scan;
}

/** The day's report as the server computed it, against the stat tiles on the dashboard. */
export async function expectDashboardShows(
  page: Page,
  report: {
    revenue: number;
    sales_count: number;
    cash_revenue: number;
    transfer_revenue: number;
    expenses: number;
    net: number;
  },
) {
  await expect(
    page.getByLabel(
      `Doanh thu ${formatVnd(report.revenue)}, ${report.sales_count} đơn`,
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel(`Tiền mặt ${formatVnd(report.cash_revenue)}`),
  ).toBeVisible();
  await expect(
    page.getByLabel(`Chuyển khoản ${formatVnd(report.transfer_revenue)}`),
  ).toBeVisible();
  await expect(
    page.getByLabel(`Chi ${formatVnd(report.expenses)}`),
  ).toBeVisible();
  await expect(page.getByLabel(`Lãi ${formatVnd(report.net)}`)).toBeVisible();
}

/**
 * A trading day through the API: two cash sales (one a loose item priced by hand), a transfer
 * sale, a purchase that makes Pepsi sell below cost, and an electricity bill.
 */
export async function seedTradingDay(api: Api) {
  const coca = await api.createProduct({
    name: 'Coca-Cola lon 330ml',
    price: 10_000,
    cost_price: 7_500,
  });
  const pepsi = await api.createProduct({
    name: 'Pepsi lon 330ml',
    price: 9_000,
    cost_price: 7_000,
  });
  const purchase = await api.createExpense({
    amount: 3 * 9_500,
    category: 'nhap_hang',
    purchase_lines: [{ product_id: pepsi.id, quantity: 3, unit_cost: 9_500 }],
  });
  const cash = await api.createSale({
    lines: [{ product_id: coca.id, unit_price: 10_000, quantity: 2 }],
  });
  const loose = await api.createSale({
    lines: [{ manual_label: 'Kẹo lạc', unit_price: 5_000, quantity: 2 }],
  });
  const transfer = await api.createSale({
    payment_method: 'transfer',
    lines: [{ product_id: coca.id, unit_price: 10_000 }],
  });
  const bill = await api.createExpense({ amount: 5_000, category: 'dien' });
  return { coca, pepsi, purchase, cash, loose, transfer, bill };
}
