import { maskText, scrubProps } from './analyticsPrivacy';

test('masks emails and phones with or without separators', () => {
  expect(maskText('call 090 123 4567 now')).toBe('call [so] now');
  expect(maskText('090-123-4567 and 090.123.4567')).toBe('[so] and [so]');
  expect(maskText('+84 90 123 4567')).toBe('[so]');
  expect(maskText('0901234567')).toBe('[so]');
  expect(maskText('mail lan@example.com')).toBe('mail [email]');
});

test('keeps money, short numbers and screen names', () => {
  expect(maskText('1.234.000 and 12345678')).toBe('1.234.000 and 12345678');
  expect(maskText('10 20 30 40 50')).toBe('10 20 30 40 50');
});

test('drops personal keys and masks string values recursively', () => {
  expect(
    scrubProps({
      $screen_name: '/stock',
      customer_name: 'Lan',
      phone: '0901234567',
      email: 'a@b.co',
      nested: { note: 'x', comment: 'ring 090 123 4567', total: 5 },
      list: [{ displayName: 'Lan', ok: true }],
    }),
  ).toEqual({
    $screen_name: '/stock',
    nested: { comment: 'ring [so]', total: 5 },
    list: [{ ok: true }],
  });
});
