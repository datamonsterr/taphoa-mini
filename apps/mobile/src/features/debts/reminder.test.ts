import { buildReminderText } from './reminder';

const bank = {
  bank_bin: '970436',
  bank_short_name: 'VCB',
  account_number: '0123456789',
  account_name: 'NGUYEN THI BA',
};
const store = { name: 'Tạp hóa Cô Ba', bank_account: bank };

test('greets the customer, names the store and the balance, and gives the transfer details', () => {
  expect(buildReminderText({ name: 'Chị Lan', balance: 125000 }, store)).toBe(
    [
      'Chào Chị Lan, Tạp hóa Cô Ba xin nhắc khoản nợ còn lại của bạn là 125.000đ.',
      'Bạn có thể chuyển khoản: VCB - 0123456789 - NGUYEN THI BA',
      'Nội dung chuyển khoản: TRA NO CHI LAN',
      'Cảm ơn bạn!',
    ].join('\n'),
  );
});

test('leaves out the transfer lines when the store has no bank account', () => {
  const expected = [
    'Chào Anh Tư, Tạp hóa Cô Ba xin nhắc khoản nợ còn lại của bạn là 40.000đ.',
    'Cảm ơn bạn!',
  ].join('\n');
  const customer = { name: 'Anh Tư', balance: 40000 };
  expect(buildReminderText(customer, { name: 'Tạp hóa Cô Ba' })).toBe(expected);
  expect(
    buildReminderText(customer, { name: 'Tạp hóa Cô Ba', bank_account: null }),
  ).toBe(expected);
});

test('uses the bank BIN when the short name is missing', () => {
  const { bank_short_name: _name, ...noName } = bank;
  expect(
    buildReminderText(
      { name: 'Lan', balance: 1000 },
      { name: 'Quán', bank_account: noName },
    ),
  ).toContain('Bạn có thể chuyển khoản: 970436 - 0123456789 - NGUYEN THI BA');
});

test('the transfer note is ASCII, upper case and fits the 25 characters VietQR allows', () => {
  const text = buildReminderText(
    { name: 'Nguyễn Thị Đông Phương Hoa', balance: 1000 },
    store,
  )!;
  const note = /Nội dung chuyển khoản: (.*)/.exec(text)![1]!;
  expect(note).toMatch(/^TRA NO [A-Z ]+$/);
  expect(note.length).toBeLessThanOrEqual(25);
  expect(note).toBe(note.trim());
});

test.each([0, -5000])('no reminder when the balance is %i', (balance) => {
  expect(buildReminderText({ name: 'Lan', balance }, store)).toBeNull();
});
