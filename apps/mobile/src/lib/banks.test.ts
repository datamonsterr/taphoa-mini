import { BANKS, bankByBin, bankLabel, searchBanks } from './banks';

test('every bank has a unique six-digit BIN', () => {
  const bins = BANKS.map((bank) => bank.bin);
  expect(new Set(bins).size).toBe(bins.length);
  expect(bins.every((bin) => /^\d{6}$/.test(bin))).toBe(true);
});

test('search finds a bank by name, abbreviation or BIN, ignoring accents and case', () => {
  expect(searchBanks('vietcom').map((b) => b.bin)).toEqual(['970436']);
  expect(searchBanks('tcb')[0]?.name).toBe('Techcombank');
  expect(searchBanks('970422')[0]?.short).toBe('MB');
  expect(searchBanks('  ')).toBe(BANKS);
  expect(searchBanks('zzz')).toEqual([]);
});

test('bankLabel prefers the saved short name, then the list, then the BIN', () => {
  expect(
    bankLabel({ bank_bin: '970436', bank_short_name: 'Vietcombank' }),
  ).toBe('Vietcombank');
  expect(bankLabel({ bank_bin: '970436', bank_short_name: null })).toBe('VCB');
  expect(bankLabel({ bank_bin: '123456' })).toBe('123456');
  expect(bankByBin('970407')?.name).toBe('Techcombank');
});
