import {
  button,
  callApi,
  cartPill,
  expect,
  formatVnd,
  openCamera,
  openShop,
  scanAndAdd,
  seedScannableProduct,
  test,
  waitForApi,
} from './fixtures';

/**
 * The debt book end to end: sell one product on credit from the pay sheet (customer created
 * inline), open the debt book from the dashboard card, collect the whole balance, and see 0đ.
 * The catalog has one product, enrolled with the very picture the fake camera shows.
 */

const COCA = { name: 'Coca-Cola lon 330ml', price: 10_000, cost_price: 7_500 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.describe('debt book', () => {
  test('sell on credit, repay, see zero balance', async ({ page, store }) => {
    test.setTimeout(120_000);
    const customerName = `Chị Lan ${crypto.randomUUID().slice(0, 6)}`;
    const phone = '0912345678';
    const coca = await seedScannableProduct(store.api, COCA);
    await openCamera(page);
    await scanAndAdd(page, coca);
    await cartPill(page).click();
    await button(page, 'Hiện mã QR thanh toán').click();
    await expect(page).toHaveURL(/\/pay/);

    // "Ghi nợ" opens the customer picker; there is nobody yet, so create the customer inline
    await page.getByRole('radio', { name: 'Ghi nợ' }).click();
    await expect(page.getByText('Chưa có khách hàng')).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Tên khách hàng' })
      .fill(customerName);
    await page
      .getByRole('textbox', { name: 'Số điện thoại (không bắt buộc)' })
      .fill(phone);
    const created = await callApi(page, 'POST', '/v1/customers', () =>
      button(page, 'Tạo khách hàng').click(),
    );
    expect(created.status).toBe(201);
    expect(created.requestBody).toMatchObject({ name: customerName, phone });
    expect(created.requestBody.id).toMatch(UUID);
    expect(created.body).toMatchObject({
      id: created.requestBody.id,
      name: customerName,
      phone,
      balance: 0,
    });
    const customerId: string = created.body.id;

    // the picker closes and the pay sheet shows who owes; nothing is paid now
    await expect(
      page.getByRole('textbox', { name: 'Tên khách hàng' }),
    ).toHaveCount(0);
    await expect(
      page.getByText(`${customerName} · Đổi khách hàng`),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Trả trước' })).toHaveValue(
      '0',
    );

    // received: one POST /v1/sales for the whole total on credit, no cash handed over
    const sale = await callApi(page, 'POST', '/v1/sales', () =>
      button(page, 'Đã nhận tiền').click(),
    );
    expect(sale.status).toBe(201);
    expect(sale.requestBody).toMatchObject({
      payment_method: 'credit',
      total: coca.price,
      credit: { customer_id: customerId, amount: coca.price },
      lines: [{ product_id: coca.id, quantity: 1, unit_price: coca.price }],
    });
    expect(sale.requestBody.cash_received).toBeUndefined();
    expect(sale.body).toMatchObject({
      id: sale.requestBody.id,
      status: 'completed',
      payment_method: 'credit',
      total: coca.price,
      credit_amount: coca.price,
      customer_id: customerId,
    });
    await expect(page.getByLabel('Đã nhận tiền xong')).toBeVisible();
    await expect(button(page, 'Giỏ hàng trống')).toBeVisible();

    // the server holds the debt
    const owed = await store.api.get(`/v1/customers/${customerId}`);
    expect(owed.balance).toBe(coca.price);

    // the dashboard card opens the debt book, which lists the customer with the balance
    const [summary] = await Promise.all([
      waitForApi(page, 'GET', '/v1/debts/summary'),
      openShop(page, '/dashboard'),
    ]);
    expect(summary.body).toMatchObject({
      total_outstanding: coca.price,
      customers_with_debt: 1,
      overdue_count: 0,
    });
    const card = button(page, /^Sổ nợ, /);
    await expect(card).toHaveAccessibleName(
      `Sổ nợ, ${formatVnd(coca.price)}, 0 khách quá hạn`,
    );
    await card.click();
    await expect(page).toHaveURL(/\/debts/);
    await expect(page.getByRole('heading', { name: 'Sổ nợ' })).toBeVisible();
    await expect(
      page.getByLabel(`Tổng nợ ${formatVnd(coca.price)}`),
    ).toBeVisible();

    // the customer screen: balance and the credit sale in the ledger
    const [opened] = await Promise.all([
      waitForApi(page, 'GET', `/v1/customers/${customerId}`),
      button(page, `${customerName}, ${formatVnd(coca.price)}`).click(),
    ]);
    expect(opened.body.balance).toBe(coca.price);
    await expect(page).toHaveURL(new RegExp(`/customer/${customerId}`));
    const balance = page.getByTestId('customer-balance');
    await expect(balance).toHaveAccessibleName(
      `Còn nợ ${formatVnd(coca.price)}`,
    );
    await expect(
      page.getByTestId('ledger-row').filter({ hasText: 'Ghi nợ' }),
    ).toHaveCount(1);

    // "Thu nợ" starts at the whole balance; collect it in cash
    await button(page, 'Thu nợ').click();
    await expect(
      page.getByRole('textbox', { name: 'Số tiền thu' }),
    ).toHaveValue(String(coca.price));
    const repayment = await callApi(
      page,
      'POST',
      `/v1/customers/${customerId}/repayments`,
      () => button(page, 'Xác nhận thu nợ').click(),
    );
    expect(repayment.status).toBe(201);
    expect(repayment.requestHeaders['idempotency-key']).toMatch(UUID);
    expect(repayment.requestBody).toMatchObject({
      amount: coca.price,
      method: 'cash',
    });
    expect(repayment.body).toMatchObject({
      customer_id: customerId,
      kind: 'repayment',
      amount: -coca.price,
      balance_after: 0,
      method: 'cash',
    });

    // the balance shows 0đ, settled, and the ledger holds both entries
    await expect(balance).toHaveAccessibleName('Hết nợ 0đ');
    await expect(balance).toContainText('0đ');
    await expect(page.getByTestId('ledger-row')).toHaveCount(2);
    const settled = await store.api.get(`/v1/customers/${customerId}`);
    expect(settled).toMatchObject({
      balance: 0,
      oldest_debt_date: null,
      overdue: false,
    });

    // back in the debt book nobody owes anything
    await button(page, 'Quay lại').click();
    await expect(page).toHaveURL(/\/debts/);
    await expect(page.getByLabel('Tổng nợ 0đ')).toBeVisible();
    await expect(button(page, `${customerName}, 0đ`)).toBeVisible();
  });
});
