import { plainMoney } from './money';

test('joins the dong sign to the number', () => {
  expect(plainMoney('Doanh thu 44.000 ₫, nợ 0 ₫ và 5.000₫.')).toBe(
    'Doanh thu 44.000đ, nợ 0đ và 5.000đ.',
  );
});

test('narrow and no-break spaces are joined too', () => {
  expect(plainMoney('1.250.000\u00a0₫ 2.000\u202f₫')).toBe('1.250.000đ 2.000đ');
});

test('text without the sign is unchanged', () => {
  expect(plainMoney('Còn 3 gói, đã bán 14 chai.')).toBe(
    'Còn 3 gói, đã bán 14 chai.',
  );
});
