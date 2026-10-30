import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { button, expect, formatVnd, openShop, test, uuid7 } from './fixtures';

/**
 * Dashboard, digest, debt book and customer screens against the real backend: the digest card
 * keeps its Mới badge until the digest is opened (#203), an empty expense tile reads 0đ (#191),
 * an overpaid customer reads Trả dư (#206), and the screens follow boards 10, 20, 21 and 23.
 * With EVIDENCE_DIR set the run also writes screenshots for the design-gap issues.
 */

async function evidence(page: Page, name: string) {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name + '.png') });
}

const card = (page: Page) => button(page, /^Tóm tắt sáng nay/);

test.describe('dashboard and digest', () => {
  test('an empty expense tile reads 0đ and the digest card keeps Mới until the digest is opened', async ({
    page,
    store,
  }) => {
    await store.api.createSale({
      lines: [{ manual_label: 'Sting đỏ', unit_price: 20_000, quantity: 1 }],
    });
    await openShop(page, '/dashboard');

    // #191: no expenses is 0đ, never −0đ
    await expect(page.getByLabel('Chi 0đ')).toBeVisible();
    await expect(page.getByText('−0đ')).toHaveCount(0);
    await expect(page.getByText('-0đ')).toHaveCount(0);

    // #203: the card shows Mới and a plain reload does not use it up
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText('Mới');
    await evidence(page, 'dashboard-top');
    await page.reload();
    await expect(card(page)).toContainText('Mới');

    await button(page, 'Chốt sổ').scrollIntoViewIfNeeded();
    await evidence(page, 'dashboard-bottom');
    await expect(button(page, /^Sổ nợ, /)).toBeVisible();
    await expect(button(page, 'Đơn gần đây')).toBeVisible();
    await expect(button(page, 'Xuất giao dịch')).toBeVisible();

    // opening the digest is what marks it read
    await card(page).scrollIntoViewIfNeeded();
    await card(page).click();
    await expect(page).toHaveURL(/\/digest/);
    await expect(
      page.getByRole('heading', { name: 'Tóm tắt sáng nay' }),
    ).toBeVisible();
    await expect(page.getByText('Hôm qua chưa có đơn nào.')).toBeVisible();
    await evidence(page, 'digest');
    // #207: the sentence writes money the way the app does, never 20.000 ₫
    await expect(page.getByText(/₫/)).toHaveCount(0);

    await openShop(page, '/dashboard');
    await expect(card(page)).toBeVisible();
    await expect(card(page)).not.toContainText('Mới');
  });
});

test.describe('debt book and customer', () => {
  test('an overpaid customer reads Trả dư; the customer screen shows phone, balance card and ledger', async ({
    page,
    store,
  }) => {
    test.setTimeout(120_000);
    const lan = { id: uuid7(), name: 'Chị Lan', phone: '0912345678' };
    const over = { id: uuid7(), name: 'Khách thử D' };
    for (const customer of [lan, over])
      await store.api.post('/v1/customers', customer);
    const saleId = uuid7();
    await store.api.post(
      '/v1/sales',
      {
        id: saleId,
        sold_at: new Date().toISOString(),
        payment_method: 'credit',
        credit: { customer_id: lan.id, amount: 50_000 },
        total: 50_000,
        lines: [
          {
            id: uuid7(),
            source: 'manual',
            manual_label: 'Gạo',
            unit_price: 50_000,
            quantity: 1,
          },
        ],
      },
      { 'Idempotency-Key': saleId },
    );
    const repayment = uuid7();
    await store.api.post(
      '/v1/customers/' + over.id + '/repayments',
      { amount: 7_000, method: 'cash' },
      { 'Idempotency-Key': repayment },
    );

    await openShop(page, '/dashboard');
    await button(page, /^Sổ nợ, /).click();
    await expect(page).toHaveURL(/\/debts/);
    await expect(page.getByRole('heading', { name: 'Sổ nợ' })).toBeVisible();

    // #206: the overpaid customer says Trả dư, not a bare minus amount
    const row = button(page, 'Khách thử D, trả dư 7.000đ');
    await expect(row).toBeVisible();
    await expect(row.getByText('Trả dư 7.000đ')).toBeVisible();
    await expect(page.getByText('-7.000đ')).toHaveCount(0);
    // board 20: total with the customer count, the overdue tile, both filter chips
    await expect(page.getByText('Tổng nợ · 1 khách')).toBeVisible();
    await expect(button(page, 'Tất cả')).toBeVisible();
    await expect(button(page, 'Quá hạn')).toBeVisible();
    await evidence(page, 'debts');

    await button(page, /^Chị Lan, /).click();
    await expect(page.getByRole('heading', { name: 'Chị Lan' })).toBeVisible();
    // board 21: the phone sits under the name; the balance card centres Đang nợ
    await expect(page.getByText('0912345678').last()).toBeVisible();
    await expect(page.getByLabel('Đang nợ ' + formatVnd(50_000))).toBeVisible();
    await expect(button(page, 'Thu nợ')).toBeVisible();
    await expect(button(page, 'Nhắc nợ')).toBeVisible();
    await expect(button(page, 'Điều chỉnh số dư (Chủ)')).toBeVisible();
    await expect(page.getByTestId('ledger-row')).toHaveCount(1);
    await expect(page.getByTestId('ledger-row')).toContainText(
      /\d\d\/\d\d · \d\d:\d\d/,
    );
    await evidence(page, 'customer');
  });
});
