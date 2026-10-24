import type { Page } from '@playwright/test';
import {
  button,
  callApi,
  createStoreViaApi,
  expect,
  hydrate,
  openShop,
  SESSION_STORAGE_KEY,
  shutter,
  test,
  trackApiBodies,
  waitForApi,
} from './fixtures';

// These tests create their stores through the UI: no pre-made session.
test.use({ storageState: { cookies: [], origins: [] } });

const field = (page: Page, label: string) =>
  page.getByRole('textbox', { name: label, exact: true });

const storedSession = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
    SESSION_STORAGE_KEY,
  );

async function openWelcome(page: Page) {
  await page.goto('/');
  await hydrate(page, button(page, 'Tạo cửa hàng'));
  await expect(page).toHaveURL(/\/welcome/);
}

test.describe('onboarding', () => {
  test('welcome offers create, join and recover; forms validate before any request', async ({
    page,
  }) => {
    await openWelcome(page);
    await expect(
      page.getByRole('heading', { name: 'Tạp Hóa Mini' }),
    ).toBeVisible();
    await expect(button(page, 'Tham gia cửa hàng')).toBeVisible();
    await expect(button(page, 'Khôi phục cửa hàng')).toBeVisible();

    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/v1/')) requests.push(request.url());
    });
    await button(page, 'Tạo cửa hàng').click();
    // the welcome screen stays mounted under the form while it slides in: wait for the form
    await expect(field(page, 'Tên cửa hàng')).toBeVisible();
    await button(page, 'Tạo cửa hàng').click();
    await expect(
      page.getByText('Nhập tên cửa hàng (tối đa 80 ký tự)'),
    ).toBeVisible();
    await expect(
      page.getByText('Nhập tên của bạn (tối đa 40 ký tự)'),
    ).toBeVisible();
    await button(page, 'Quay lại').click();
    await button(page, 'Khôi phục cửa hàng').click();
    await expect(field(page, 'Mã khôi phục')).toBeVisible();
    await button(page, 'Khôi phục').click();
    await expect(
      page.getByText('Nhập mã khôi phục', { exact: true }),
    ).toBeVisible();
    expect(requests).toEqual([]);
  });

  test('create a store: the recovery code on screen is the API answer, continue opens the home', async ({
    page,
  }) => {
    await openWelcome(page);
    await button(page, 'Tạo cửa hàng').click();
    await field(page, 'Tên cửa hàng').fill('Tạp hóa Cô Ba');
    await field(page, 'Tên của bạn').fill('Cô Ba');

    const created = await callApi(page, 'POST', '/v1/stores', () =>
      button(page, 'Tạo cửa hàng').click(),
    );
    expect(created.status).toBe(201);
    expect(created.requestBody).toMatchObject({
      store_name: 'Tạp hóa Cô Ba',
      display_name: 'Cô Ba',
      device: { platform: 'web' },
    });
    expect(created.body.store.name).toBe('Tạp hóa Cô Ba');
    expect(created.body.member).toMatchObject({
      display_name: 'Cô Ba',
      role: 'lead',
    });

    // the code is shown once, exactly as the server issued it
    await expect(page).toHaveURL(/\/recovery-code/);
    const code: string = created.body.recovery_code;
    expect(code).toBeTruthy();
    await expect(
      page.getByLabel(`Mã khôi phục của bạn: ${code}`),
    ).toBeVisible();
    await expect(page.getByText(code, { exact: true })).toBeVisible();

    // the session the server issued is what the phone keeps
    expect(await storedSession(page)).toMatchObject({
      access_token: created.body.access_token,
      refresh_token: created.body.refresh_token,
      store: { id: created.body.store.id },
    });

    await button(page, 'Tiếp tục').click();
    await expect(shutter(page)).toBeVisible();
    await expect(page).not.toHaveURL(/recovery-code|welcome/);

    // the store the server holds is the one the account screen shows
    const [store, members] = await Promise.all([
      waitForApi(page, 'GET', '/v1/store'),
      waitForApi(page, 'GET', '/v1/members'),
      openShop(page, '/account'),
    ]);
    expect(store.body.id).toBe(created.body.store.id);
    await expect(
      page.getByRole('heading', { name: store.body.name }),
    ).toBeVisible();
    expect(members.body.items).toHaveLength(1);
    await expect(page.getByLabel('1 thành viên')).toBeVisible();
    await expect(page.getByText('Chủ', { exact: true })).toBeVisible();
  });

  test('sign out returns to welcome; the saved code recovers the store and rotates', async ({
    page,
  }) => {
    // a store made by the UI: its code is what the person wrote down
    await openWelcome(page);
    await button(page, 'Tạo cửa hàng').click();
    await field(page, 'Tên cửa hàng').fill('Tạp hóa Khôi phục');
    await field(page, 'Tên của bạn').fill('Bà Tư');
    const created = await callApi(page, 'POST', '/v1/stores', () =>
      button(page, 'Tạo cửa hàng').click(),
    );
    const code: string = created.body.recovery_code;
    await button(page, 'Tiếp tục').click();
    await expect(shutter(page)).toBeVisible();

    await openShop(page, '/account');
    const out = await callApi(page, 'POST', '/v1/auth/logout', () =>
      button(page, 'Đăng xuất').click(),
    );
    expect(out.status).toBeLessThan(300);
    await expect(button(page, 'Tạo cửa hàng')).toBeVisible();
    await expect(page).toHaveURL(/\/welcome/);
    expect(await storedSession(page)).toBeNull();

    // a wrong code is refused by the server and said so
    await button(page, 'Khôi phục cửa hàng').click();
    await field(page, 'Mã khôi phục').fill('SAI-MA-0000');
    const refused = await callApi(
      page,
      'POST',
      '/v1/auth/recover',
      () => button(page, 'Khôi phục').click(),
      401,
    );
    expect(refused.requestBody.recovery_code).toBe('SAI-MA-0000');
    await expect(page.getByText('Mã khôi phục không đúng.')).toBeVisible();

    // the right one signs in as the same Lead and shows the rotated code
    await field(page, 'Mã khôi phục').fill(code);
    const recovered = await callApi(page, 'POST', '/v1/auth/recover', () =>
      button(page, 'Khôi phục').click(),
    );
    expect(recovered.requestBody.recovery_code).toBe(code);
    expect(recovered.body.store.id).toBe(created.body.store.id);
    expect(recovered.body.member.id).toBe(created.body.member.id);
    const rotated: string = recovered.body.recovery_code;
    expect(rotated).not.toBe(code);
    await expect(page).toHaveURL(/\/recovery-code/);
    await expect(
      page.getByLabel(`Mã khôi phục của bạn: ${rotated}`),
    ).toBeVisible();

    await button(page, 'Tiếp tục').click();
    await expect(shutter(page)).toBeVisible();
    await openShop(page, '/account');
    await expect(
      page.getByRole('heading', { name: 'Tạp hóa Khôi phục' }),
    ).toBeVisible();
  });

  test('a Lead invites in Account; a seller joins from a second browser; the code works once', async ({
    page,
    browser,
    baseURL,
  }) => {
    // Lead: made through the API, signed in on the first page
    const lead = await createStoreViaApi('Tạp hóa Mời', 'Chủ Hai');
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key!, value!),
      [SESSION_STORAGE_KEY, JSON.stringify(lead.session)],
    );
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

    // Seller: a second browser with its own storage
    const context = await browser.newContext({
      baseURL,
      permissions: ['camera'],
      viewport: { width: 390, height: 844 },
    });
    await trackApiBodies(context);
    try {
      const seller = await context.newPage();
      await openWelcome(seller);
      await button(seller, 'Tham gia cửa hàng').click();
      await field(seller, 'Mã mời').fill(token.toLowerCase());
      await field(seller, 'Tên của bạn').fill('Bé Út');
      const joined = await callApi(seller, 'POST', '/v1/auth/join', () =>
        button(seller, 'Tham gia').click(),
      );
      expect(joined.requestBody).toMatchObject({
        invite_token: token,
        display_name: 'Bé Út',
      });
      expect(joined.body.member).toMatchObject({
        display_name: 'Bé Út',
        role: 'seller',
      });
      expect(joined.body.store.id).toBe(lead.session.store.id);
      await expect(shutter(seller)).toBeVisible();

      // the seller sees the store and two members, as the server lists them
      const [members] = await Promise.all([
        waitForApi(seller, 'GET', '/v1/members'),
        openShop(seller, '/account'),
      ]);
      expect(members.body.items.map((m: any) => m.display_name).sort()).toEqual(
        ['Bé Út', 'Chủ Hai'],
      );
      await expect(seller.getByLabel('2 thành viên')).toBeVisible();
      await expect(
        seller.getByRole('heading', { name: 'Tạp hóa Mời' }),
      ).toBeVisible();

      // an invite is single-use: a second phone with the same code is refused
      const other = await browser.newContext({ baseURL });
      await trackApiBodies(other);
      try {
        const page2 = await other.newPage();
        await openWelcome(page2);
        await button(page2, 'Tham gia cửa hàng').click();
        await field(page2, 'Mã mời').fill(token);
        await field(page2, 'Tên của bạn').fill('Người lạ');
        await callApi(
          page2,
          'POST',
          '/v1/auth/join',
          () => button(page2, 'Tham gia').click(),
          410,
        );
        await expect(
          page2.getByText('Mã mời đã hết hạn hoặc đã được dùng.'),
        ).toBeVisible();
      } finally {
        await other.close();
      }
    } finally {
      await context.close();
    }

    // the Lead's list now has the seller too
    await page.reload();
    await expect(page.getByLabel('2 thành viên')).toBeVisible();
  });
});
