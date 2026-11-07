import type { Locator, Page } from '@playwright/test';
import { setupClerkTestingToken } from '@clerk/testing/playwright';
import {
  button,
  callApi,
  createNewcomer,
  deleteClerkUsersByEmail,
  expect,
  http,
  hydrate,
  openShop,
  openSignedInPhone,
  shopHome,
  signInScreen,
  TEST_CODE,
  test,
  uniqueEmail,
  waitForApi,
  welcomeScreen,
} from './fixtures';

const field = (page: Page, label: string) =>
  page.getByRole('textbox', { name: label, exact: true });
const byId = (page: Page, id: string) => page.getByTestId(id);
const codeScreen = (page: Page) => byId(page, 'auth-code-screen');

/** Clerk's Frontend API limits sign-ins per IP; the app shows this when it answers 429. */
const RATE_LIMITED = 'Thử quá nhiều lần. Đợi một lúc rồi thử lại.';

/**
 * Presses `submit` until `done` shows. A rate-limited Clerk answer (the app says so on screen)
 * is retried with a growing pause: the Frontend API allows few sign-ins and attempts per 10 s.
 */
async function submitUntil(page: Page, submit: Locator, done: Locator) {
  const limited = page.getByText(RATE_LIMITED);
  for (let attempt = 1; ; attempt += 1) {
    await submit.click();
    await expect(done.or(limited)).toBeVisible({ timeout: 30_000 });
    if (await done.isVisible()) return;
    if (attempt >= 4) throw new Error('Clerk kept rate limiting the sign-in');
    await page.waitForTimeout(3_000 * attempt);
  }
}

/**
 * The sign-in screens as a person uses them: the address, "Gửi mã", then the 6-digit code that
 * every `+clerk_test` address accepts. Works for a new address (an account is made) and for an
 * existing one. Returns when `landing` is visible.
 */
async function signInWithEmailCode(
  page: Page,
  email: string,
  landing: Locator,
) {
  await expect(signInScreen(page)).toBeVisible();
  await field(page, 'Địa chỉ email').fill(email);
  await submitUntil(page, byId(page, 'auth-send-code'), codeScreen(page));
  await expect(
    codeScreen(page).getByText(email, { exact: true }),
  ).toBeVisible();
  await field(page, 'Mã xác nhận 6 chữ số').fill(TEST_CODE);
  await submitUntil(page, byId(page, 'auth-verify-code'), landing);
}

test.describe('sign-in screens', () => {
  test.use({ signedIn: false });

  test('a signed-out visitor lands on sign-in; a bad email is refused before any request', async ({
    page,
  }) => {
    await page.goto('/');
    await hydrate(page, signInScreen(page));
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(
      page.getByRole('heading', { name: 'Đăng nhập' }),
    ).toBeVisible();
    await expect(button(page, 'Gửi mã')).toBeVisible();
    await expect(button(page, 'Tiếp tục với Google')).toBeVisible();

    // every shop route is closed to a signed-out visitor
    await page.goto('/account');
    await hydrate(page, signInScreen(page));
    await expect(page).toHaveURL(/\/sign-in/);

    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET' && request.url().includes('/v1/'))
        writes.push(`${request.method()} ${request.url()}`);
    });
    await field(page, 'Địa chỉ email').fill('khong-phai-email');
    await button(page, 'Gửi mã').click();
    await expect(page.getByText('Nhập địa chỉ email hợp lệ.')).toBeVisible();
    expect(writes).toEqual([]);
  });

  test('a user without a store signs in with email and code, creates one and lands in the shop', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // a Clerk user the Backend API made: verified address, no store yet
    const newcomer = await createNewcomer();
    await setupClerkTestingToken({ page });
    await page.goto('/');
    await hydrate(page, signInScreen(page));
    await signInWithEmailCode(page, newcomer.email, welcomeScreen(page));

    // signed in, but no store yet: create or join (no recovery any more)
    await expect(
      page.getByRole('heading', { name: 'Tạp Hóa Mini' }),
    ).toBeVisible();
    await expect(byId(page, 'onboarding-create')).toBeVisible();
    await expect(button(page, 'Tham gia cửa hàng')).toBeVisible();
    await expect(button(page, 'Đăng xuất')).toBeVisible();
    await expect(page.getByText('Khôi phục cửa hàng')).toHaveCount(0);

    // the forms validate before any request
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET' && request.url().includes('/v1/'))
        writes.push(`${request.method()} ${request.url()}`);
    });
    await byId(page, 'onboarding-create').click();
    await expect(field(page, 'Tên cửa hàng')).toBeVisible();
    await byId(page, 'create-store-submit').click();
    await expect(
      page.getByText('Nhập tên cửa hàng (tối đa 80 ký tự)'),
    ).toBeVisible();
    await expect(
      page.getByText('Nhập tên của bạn (tối đa 40 ký tự)'),
    ).toBeVisible();
    expect(writes).toEqual([]);

    await field(page, 'Tên cửa hàng').fill('Tạp hóa Cô Ba');
    await field(page, 'Tên của bạn').fill('Cô Ba');
    const created = await callApi(page, 'POST', '/v1/stores', () =>
      byId(page, 'create-store-submit').click(),
    );
    expect(created.status).toBe(201);
    expect(created.requestBody).toEqual({
      store_name: 'Tạp hóa Cô Ba',
      display_name: 'Cô Ba',
    });
    // a Clerk session token, and no store to name yet
    expect(created.requestHeaders.authorization).toMatch(/^Bearer ey/);
    expect(created.requestHeaders['x-store-id']).toBeUndefined();
    expect(created.body.store.name).toBe('Tạp hóa Cô Ba');
    expect(created.body.member).toMatchObject({
      display_name: 'Cô Ba',
      role: 'lead',
    });
    await expect(shopHome(page)).toBeVisible();

    // the store the server holds is the one the account screen shows, asked for by id
    const [me, store, members] = await Promise.all([
      waitForApi(page, 'GET', '/v1/me'),
      waitForApi(page, 'GET', '/v1/store'),
      waitForApi(page, 'GET', '/v1/members'),
      openShop(page, '/account'),
    ]);
    expect(me.body.clerk_user_id).toBe(newcomer.userId);
    expect(me.body.memberships).toHaveLength(1);
    expect(me.body.memberships[0].store.id).toBe(created.body.store.id);
    expect(store.requestHeaders['x-store-id']).toBe(created.body.store.id);
    expect(store.body.id).toBe(created.body.store.id);
    await expect(
      page.getByRole('heading', { name: store.body.name }),
    ).toBeVisible();
    expect(members.body.items).toHaveLength(1);
    await expect(page.getByLabel('1 thành viên')).toBeVisible();
    await expect(page.getByText('Chủ', { exact: true })).toBeVisible();
  });

  test('a brand-new email signs up with code 424242 and reaches the welcome screen', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const blockedBy = process.env.E2E_CLERK_SIGNUP_BLOCKED_BY;
    test.skip(
      !!blockedBy,
      `the Clerk instance requires ${blockedBy} at sign-up, which the email-code screens cannot supply`,
    );
    const email = uniqueEmail();
    try {
      await setupClerkTestingToken({ page });
      await page.goto('/');
      await hydrate(page, signInScreen(page));
      await signInWithEmailCode(page, email, welcomeScreen(page));
      await expect(byId(page, 'onboarding-create')).toBeVisible();
      await expect(button(page, 'Tham gia cửa hàng')).toBeVisible();
    } finally {
      // this user was made by the sign-up screens: no fixture tracked it
      await deleteClerkUsersByEmail(email);
    }
  });

  test('a returning member signs in with email and code; "Đăng xuất" ends the session and returns to sign-in', async ({
    page,
    store,
  }) => {
    test.setTimeout(120_000);
    await setupClerkTestingToken({ page });
    await page.goto('/');
    await hydrate(page, signInScreen(page));

    // a wrong code is refused by Clerk and said so
    await field(page, 'Địa chỉ email').fill(store.user.email);
    await submitUntil(page, byId(page, 'auth-send-code'), codeScreen(page));
    await field(page, 'Mã xác nhận 6 chữ số').fill('000000');
    await byId(page, 'auth-verify-code').click();
    await expect(
      page.getByText('Mã xác nhận không đúng. Vui lòng thử lại.'),
    ).toBeVisible();

    // the right one opens the shop of the existing membership: no onboarding
    await field(page, 'Mã xác nhận 6 chữ số').fill(TEST_CODE);
    await submitUntil(page, byId(page, 'auth-verify-code'), shopHome(page));
    const [me] = await Promise.all([
      waitForApi(page, 'GET', '/v1/me'),
      openShop(page, '/account'),
    ]);
    expect(me.body.memberships.map((m: any) => m.store.id)).toEqual([
      store.session.store.id,
    ]);

    // "Đăng xuất" signs this session out: back to sign-in, and the shop stays closed
    await button(page, 'Đăng xuất').click();
    await expect(signInScreen(page)).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in/);
    await page.goto('/account');
    await hydrate(page, signInScreen(page));
    await expect(page).toHaveURL(/\/sign-in/);
  });
});

test.describe('invites', () => {
  test('a Lead invites in Account; the code works once', async ({
    page,
    store,
  }) => {
    await openShop(page, '/account');
    await expect(page.getByLabel('1 thành viên')).toBeVisible();

    const invite = await callApi(page, 'POST', '/v1/invites', () =>
      button(page, 'Mời bằng mã QR').click(),
    );
    expect(invite.status).toBe(201);
    expect(invite.requestBody).toMatchObject({
      role: 'seller',
      can_enroll: false,
    });
    const token: string = invite.body.token;
    const sheet = page.getByTestId('sheet-panel');
    await expect(
      sheet.getByRole('heading', { name: 'Mã mời vào cửa hàng' }),
    ).toBeVisible();
    await expect(
      sheet.getByText(token.match(/.{1,4}/g)!.join(' ')),
    ).toBeVisible();
    await expect(sheet.getByText(/^Hết hạn lúc \d\d:\d\d$/)).toBeVisible();

    // a seller (a new Clerk user) redeems it ...
    const seller = await createNewcomer();
    const joined = await http('POST', '/v1/auth/join', {
      token: seller.token,
      body: { invite_token: token, display_name: 'Bé Út' },
    });
    expect(joined.member).toMatchObject({
      display_name: 'Bé Út',
      role: 'seller',
    });
    expect(joined.store.id).toBe(store.session.store.id);

    // ... and nobody else can: an invite is single-use
    const stranger = await createNewcomer();
    await expect(
      http('POST', '/v1/auth/join', {
        token: stranger.token,
        body: { invite_token: token, display_name: 'Người lạ' },
      }),
    ).rejects.toMatchObject({ status: 410 });

    // the Lead's list now has the seller too
    await page.reload();
    await expect(page.getByLabel('2 thành viên')).toBeVisible();
  });

  test.describe('join from sign-in', () => {
    test.use({ signedIn: false });

    test('a new user opens an invite link, signs in and joins; the same code is then refused', async ({
      page,
      store,
      browser,
      baseURL,
    }) => {
      test.setTimeout(180_000);
      const invite = await store.api.post('/v1/invites', {
        role: 'seller',
        can_enroll: false,
        ttl_seconds: 600,
      });
      const token: string = invite.token;
      const newcomer = await createNewcomer();
      await setupClerkTestingToken({ page });
      // signed out: the link is kept in memory through sign-in and prefills the join form
      await page.goto(`/join?token=${encodeURIComponent(token)}`);
      await hydrate(page, signInScreen(page));
      await signInWithEmailCode(page, newcomer.email, welcomeScreen(page));
      await byId(page, 'onboarding-join').click();
      await expect(field(page, 'Mã mời')).toHaveValue(token);
      await field(page, 'Tên của bạn').fill('Bé Út');
      const joined = await callApi(page, 'POST', '/v1/auth/join', () =>
        byId(page, 'join-store-submit').click(),
      );
      expect(joined.requestBody).toEqual({
        invite_token: token,
        display_name: 'Bé Út',
      });
      expect(joined.requestHeaders.authorization).toMatch(/^Bearer ey/);
      expect(joined.body.member).toMatchObject({
        display_name: 'Bé Út',
        role: 'seller',
      });
      expect(joined.body.store.id).toBe(store.session.store.id);
      await expect(shopHome(page)).toBeVisible();

      // the seller sees the store and two members, as the server lists them
      const [members] = await Promise.all([
        waitForApi(page, 'GET', '/v1/members'),
        openShop(page, '/account'),
      ]);
      expect(members.body.items.map((m: any) => m.display_name).sort()).toEqual(
        ['Bé Út', 'Cô Ba'],
      );
      await expect(page.getByLabel('2 thành viên')).toBeVisible();
      await expect(page.getByText('Người bán', { exact: true })).toBeVisible();

      // a second phone, another new user, the same code typed by hand: refused
      const stranger = await createNewcomer();
      const phone = await openSignedInPhone(browser, baseURL, stranger);
      try {
        await expect(welcomeScreen(phone.page)).toBeVisible();
        await byId(phone.page, 'onboarding-join').click();
        await field(phone.page, 'Mã mời').fill(token.toLowerCase());
        await field(phone.page, 'Tên của bạn').fill('Người lạ');
        const refused = await callApi(
          phone.page,
          'POST',
          '/v1/auth/join',
          () => byId(phone.page, 'join-store-submit').click(),
          410,
        );
        expect(refused.requestBody.invite_token).toBe(token);
        await expect(
          phone.page.getByText('Mã mời đã hết hạn hoặc đã được dùng.'),
        ).toBeVisible();

        // without a store the person can still leave: sign out returns to sign-in
        await phone.page.goBack();
        await byId(phone.page, 'onboarding-sign-out').click();
        await expect(signInScreen(phone.page)).toBeVisible();
      } finally {
        await phone.context.close();
      }
    });
  });
});
