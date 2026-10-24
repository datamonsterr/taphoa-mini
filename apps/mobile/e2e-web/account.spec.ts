import type { Locator, Page } from '@playwright/test';
import {
  button,
  callApi,
  expect,
  http,
  openShop,
  SESSION_STORAGE_KEY,
  test,
  waitForApi,
  type Session,
} from './fixtures';

const elderSwitch = (page: Page, name = 'Chế độ người lớn tuổi') =>
  page.getByRole('switch', { name });
const scaleText = (page: Page) => page.getByText(/^\d+%$/);
const bankRow = (page: Page, name = 'Tài khoản ngân hàng VietQR') =>
  button(page, name);

/** Joins the Lead's store as a seller through the API (the UI path is in onboarding.spec). */
async function joinAsSeller(lead: { token: string }, name = 'Bé Út') {
  const invite = await http('POST', '/v1/invites', {
    token: lead.token,
    body: { role: 'seller', can_enroll: false, ttl_seconds: 600 },
  });
  const body = await http('POST', '/v1/auth/join', {
    body: {
      invite_token: invite.token,
      display_name: name,
      device: { name: 'Playwright seller', platform: 'web' },
    },
  });
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    member: body.member,
    store: body.store,
  } satisfies Session;
}

test.describe('account', () => {
  test('store, role, members and the bank row are what the server returns', async ({
    page,
    store,
  }) => {
    await store.api.setBank();
    const seller = await joinAsSeller(store.api);
    const [me, info, members] = await Promise.all([
      waitForApi(page, 'GET', '/v1/me'),
      waitForApi(page, 'GET', '/v1/store'),
      waitForApi(page, 'GET', '/v1/members'),
      openShop(page, '/account'),
    ]);
    await expect(
      page.getByRole('heading', { name: info.body.name }),
    ).toBeVisible();
    expect(info.body.id).toBe(store.session.store.id);
    expect(me.body.member.role).toBe('lead');
    await expect(page.getByText('Chủ', { exact: true })).toBeVisible();
    expect(members.body.items.map((m: any) => m.id).sort()).toEqual(
      [store.session.member.id, seller.member.id].sort(),
    );
    await expect(
      page.getByLabel(`${members.body.items.length} thành viên`),
    ).toBeVisible();
    await expect(button(page, 'Mời bằng mã QR')).toBeVisible();
    await expect(bankRow(page)).toContainText('VCB · 0123 456 789');
  });

  test('bank sheet: validation errors, then PATCH /v1/store and the row shows the saved account', async ({
    page,
    store,
  }) => {
    await openShop(page, '/account');
    await expect(bankRow(page)).toContainText('Thêm tài khoản ngân hàng');
    await bankRow(page).click();
    const sheet = page.getByTestId('sheet-panel');
    await expect(
      sheet.getByRole('heading', { name: 'Tài khoản nhận tiền' }),
    ).toBeVisible();
    const bank = sheet.getByRole('textbox', { name: 'Ngân hàng', exact: true });
    const bin = sheet.getByRole('textbox', { name: 'Mã BIN ngân hàng' });
    const number = sheet.getByRole('textbox', { name: 'Số tài khoản' });
    const holder = sheet.getByRole('textbox', { name: 'Chủ tài khoản' });

    // nothing reaches the server while the form is invalid
    const patches: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH') patches.push(r.url());
    });
    await bin.fill('123');
    await number.fill('12');
    await button(sheet, 'Lưu').click();
    await expect(sheet.getByText('Mã BIN gồm 6 chữ số')).toBeVisible();
    await expect(sheet.getByText('Số tài khoản gồm 4–19 ký tự')).toBeVisible();
    await expect(sheet.getByText('Nhập tên chủ tài khoản')).toBeVisible();
    expect(patches).toEqual([]);

    await bank.fill('Techcombank');
    await bin.fill('970407');
    await number.fill('9876543210');
    await holder.fill('Trần Thị Bé');
    await expect(holder).toHaveValue('TRAN THI BE');
    const saved = await callApi(page, 'PATCH', '/v1/store', () =>
      button(sheet, 'Lưu').click(),
    );
    expect(saved.requestBody.bank_account).toMatchObject({
      bank_bin: '970407',
      account_number: '9876543210',
      account_name: 'TRAN THI BE',
      bank_short_name: 'Techcombank',
    });
    expect(saved.body.bank_account).toMatchObject(
      saved.requestBody.bank_account,
    );
    await expect(sheet).toHaveCount(0);
    await expect(bankRow(page)).toContainText('Techcombank · 9876 543 210');

    // the server kept it
    const stored = await store.api.get('/v1/store');
    expect(stored.bank_account).toMatchObject({
      bank_bin: '970407',
      account_number: '9876543210',
    });
  });

  test('a seller sees the store but none of the Lead-only controls, and the app asks for nothing a seller may not read', async ({
    browser,
    baseURL,
    store,
  }) => {
    await store.api.setBank();
    const seller = await joinAsSeller(store.api);
    const context = await browser.newContext({
      baseURL,
      permissions: ['camera'],
      viewport: { width: 390, height: 844 },
      storageState: {
        cookies: [],
        origins: [
          {
            origin: new URL(baseURL!).origin,
            localStorage: [
              { name: SESSION_STORAGE_KEY, value: JSON.stringify(seller) },
            ],
          },
        ],
      },
    });
    try {
      const page = await context.newPage();
      const refused: string[] = [];
      page.on('response', (r) => {
        if (r.url().includes('/v1/') && r.status() >= 400)
          refused.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      });

      await openShop(page, '/account');
      await expect(page.getByText('Người bán', { exact: true })).toBeVisible();
      await expect(button(page, 'Mời bằng mã QR')).toHaveCount(0);
      await expect(bankRow(page)).toBeDisabled();
      await expect(bankRow(page)).toContainText('VCB · 0123 456 789');

      // the dashboard hides what a seller's request would answer 403 to
      await page.getByRole('tab', { name: 'Báo cáo', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Báo cáo' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /^\d+ món/ })).toHaveCount(
        0,
      );
      await expect(
        page.getByRole('button', { name: /dưới giá nhập$/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: /không có trong kho$/ }),
      ).toHaveCount(0);
      expect(refused).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

/** A seller of the Lead's store who has a PIN, as the shared counter phone would hold. */
async function joinWithPin(
  lead: { token: string },
  pin: string,
  name = 'Bé Út',
) {
  const seller = await joinAsSeller(lead, name);
  await http('PUT', '/v1/me/pin', {
    token: seller.access_token,
    body: { pin },
  });
  return seller;
}

const tapKeys = async (scope: Page | Locator, digits: string) => {
  for (const digit of digits) await button(scope, digit).click();
};

const SWITCH = '/v1/auth/switch';

test.describe('switching the acting member (U3, U4)', () => {
  test('the Lead switches to a seller with the PIN, then back to the Lead who has none', async ({
    page,
    store,
  }) => {
    const seller = await joinWithPin(store.api, '4821');
    await openShop(page, '/account');
    await expect(page.getByText('Đang dùng: Cô Ba')).toBeVisible();
    await expect(button(page, 'Chuyển sang Cô Ba')).toHaveCount(0);

    await button(page, 'Chuyển sang Bé Út').click();
    const sheet = page.getByTestId('sheet-panel');
    await expect(
      sheet.getByRole('heading', { name: 'Mã PIN của Bé Út' }),
    ).toBeVisible();

    // a wrong PIN: 401, an explanation, and the Lead is still the acting member
    await tapKeys(sheet, '0000');
    const refused = await callApi(
      page,
      'POST',
      SWITCH,
      () => button(sheet, 'Xác nhận').click(),
      401,
    );
    expect(refused.requestBody).toEqual({
      member_id: seller.member.id,
      pin: '0000',
    });
    await expect(sheet.getByText('Mã PIN không đúng')).toBeVisible();
    await expect(page.getByLabel('4 chữ số đã nhập')).toBeVisible();

    // the right PIN: 200, the session is the seller's, the screen shows the seller
    for (let i = 0; i < 4; i += 1) await button(sheet, 'Xóa').click();
    await tapKeys(sheet, '4821');
    const switched = await callApi(page, 'POST', SWITCH, () =>
      button(sheet, 'Xác nhận').click(),
    );
    expect(switched.requestBody).toEqual({
      member_id: seller.member.id,
      pin: '4821',
    });
    expect(switched.body.member).toMatchObject({
      id: seller.member.id,
      role: 'seller',
    });
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText('Đang dùng: Bé Út')).toBeVisible();
    await expect(page.getByText('Người bán', { exact: true })).toBeVisible();
    await expect(button(page, 'Mời bằng mã QR')).toHaveCount(0);
    const stored = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      SESSION_STORAGE_KEY,
    );
    expect(stored.member.id).toBe(seller.member.id);
    expect(stored.access_token).toBe(switched.body.access_token);
    const me = await http('GET', '/v1/me', { token: stored.access_token });
    expect(me.member.id).toBe(seller.member.id);

    // the Lead has no PIN: one tap and the phone is the Lead's again
    const back = await callApi(page, 'POST', SWITCH, () =>
      button(page, 'Chuyển sang Cô Ba').click(),
    );
    expect(back.requestBody).toEqual({ member_id: store.session.member.id });
    await expect(page.getByText('Đang dùng: Cô Ba')).toBeVisible();
    await expect(button(page, 'Mời bằng mã QR')).toBeVisible();
  });

  test('"Đặt mã PIN": two matching entries, PUT /v1/me/pin, and the server holds a PIN', async ({
    page,
    store,
  }) => {
    await openShop(page, '/account');
    expect(
      (await store.api.get('/v1/members')).items.find(
        (m: any) => m.id === store.session.member.id,
      ).has_pin,
    ).toBe(false);
    await button(page, 'Đặt mã PIN').click();
    const sheet = page.getByTestId('sheet-panel');
    await expect(
      sheet.getByRole('heading', { name: 'Mã PIN mới (4–6 chữ số)' }),
    ).toBeVisible();
    await expect(button(sheet, 'Tiếp')).toBeDisabled();

    // different second entry: starts over, saves nothing
    await tapKeys(sheet, '1357');
    await button(sheet, 'Tiếp').click();
    await tapKeys(sheet, '1358');
    await button(sheet, 'Xác nhận').click();
    await expect(sheet.getByText('Hai mã PIN không khớp')).toBeVisible();

    await tapKeys(sheet, '135790');
    await button(sheet, 'Tiếp').click();
    await expect(
      sheet.getByRole('heading', { name: 'Nhập lại mã PIN' }),
    ).toBeVisible();
    await tapKeys(sheet, '135790');
    const saved = await callApi(page, 'PUT', '/v1/me/pin', () =>
      button(sheet, 'Xác nhận').click(),
    );
    expect(saved.requestBody).toEqual({ pin: '135790' });
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText('Đã đặt mã PIN')).toBeVisible();
    expect(
      (await store.api.get('/v1/members')).items.find(
        (m: any) => m.id === store.session.member.id,
      ).has_pin,
    ).toBe(true);

    // and it is the PIN the switch now asks of the Lead: a seller phone must give it
    const seller = await joinAsSeller(store.api, 'Bé Hai');
    const asSeller = await http('POST', SWITCH, {
      token: seller.access_token,
      body: { member_id: store.session.member.id, pin: '135790' },
    });
    expect(asSeller.member.id).toBe(store.session.member.id);
  });
});

test.describe('settings on this phone', () => {
  test('elder mode floors the text size; text size +/− steps and hits the limits', async ({
    page,
  }) => {
    await openShop(page, '/account');
    await expect(elderSwitch(page)).not.toBeChecked();
    await expect(scaleText(page)).toHaveText('100%');
    await expect(button(page, 'Chữ nhỏ hơn')).toBeDisabled();

    await button(page, 'Chữ to hơn').click();
    await expect(scaleText(page)).toHaveText('125%');
    await button(page, 'Chữ nhỏ hơn').click();
    await expect(scaleText(page)).toHaveText('100%');

    await elderSwitch(page).click();
    await expect(elderSwitch(page)).toBeChecked();
    await expect(scaleText(page)).toHaveText('125%');
    await expect(button(page, 'Chữ nhỏ hơn')).toBeDisabled();
    for (const next of ['150%', '175%', '200%']) {
      await button(page, 'Chữ to hơn').click();
      await expect(scaleText(page)).toHaveText(next);
    }
    await expect(button(page, 'Chữ to hơn')).toBeDisabled();
    await elderSwitch(page).click();
    await expect(elderSwitch(page)).not.toBeChecked();
  });

  test('VI/EN toggle changes the labels, and settings survive a reload', async ({
    page,
  }) => {
    await openShop(page, '/account');
    await expect(page.getByRole('radio', { name: 'VI' })).toBeChecked();
    await page.getByRole('radio', { name: 'EN' }).click();
    await expect(page.getByRole('radio', { name: 'EN' })).toBeChecked();
    await expect(page.getByText('Owner', { exact: true })).toBeVisible();
    await expect(button(page, 'Invite with QR code')).toBeVisible();
    await expect(
      page.getByRole('tab', { name: 'Stock', exact: true }),
    ).toBeVisible();
    await elderSwitch(page, 'Elder mode').click();
    await button(page, 'Larger text').click();
    await expect(scaleText(page)).toHaveText('150%');

    await page.reload();
    await expect(page.getByRole('tablist')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'EN' })).toBeChecked();
    await expect(elderSwitch(page, 'Elder mode')).toBeChecked();
    await expect(scaleText(page)).toHaveText('150%');
    // still signed in: the session is not a setting
    await expect(button(page, 'Sign out')).toBeVisible();
  });
});
