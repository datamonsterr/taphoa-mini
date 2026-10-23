import { applyKey, KEYPAD_LAYOUT } from './keypad';

describe('applyKey', () => {
  test('appends digits', () => {
    expect(applyKey('', '7', 8)).toBe('7');
    expect(applyKey('7', '5', 8)).toBe('75');
  });

  test('000 appends three zeros', () => {
    expect(applyKey('12', '000', 8)).toBe('12000');
  });

  test('leading zeros collapse', () => {
    expect(applyKey('', '0', 8)).toBe('0');
    expect(applyKey('', '000', 8)).toBe('0');
    expect(applyKey('0', '0', 8)).toBe('0');
    expect(applyKey('0', '000', 8)).toBe('0');
    expect(applyKey('0', '5', 8)).toBe('5');
  });

  test('delete removes the last digit and is safe when empty', () => {
    expect(applyKey('125', 'delete', 8)).toBe('12');
    expect(applyKey('5', 'delete', 8)).toBe('');
    expect(applyKey('', 'delete', 8)).toBe('');
  });

  test('ignores a press that would exceed max digits', () => {
    expect(applyKey('1234567', '8', 8)).toBe('12345678');
    expect(applyKey('12345678', '9', 8)).toBe('12345678');
    expect(applyKey('12345', '000', 6)).toBe('12345');
  });

  test('layout is 1-9, 000, 0, delete', () => {
    expect(KEYPAD_LAYOUT).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '000',
      '0',
      'delete',
    ]);
  });
});
