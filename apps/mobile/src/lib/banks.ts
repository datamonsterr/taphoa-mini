/** A VietQR payee bank: the NAPAS BIN goes in the QR, `short` is what the shop owner reads. */
export type Bank = { bin: string; short: string; name: string };

/** Banks that accept VietQR transfers (api.vietqr.io/v2/banks, `transferSupported`), best known first. */
export const BANKS: readonly Bank[] = [
  { bin: '970436', short: 'VCB', name: 'Vietcombank' },
  { bin: '970415', short: 'CTG', name: 'VietinBank' },
  { bin: '970418', short: 'BIDV', name: 'BIDV' },
  { bin: '970405', short: 'AGB', name: 'Agribank' },
  { bin: '970407', short: 'TCB', name: 'Techcombank' },
  { bin: '970422', short: 'MB', name: 'MB Bank' },
  { bin: '970416', short: 'ACB', name: 'ACB' },
  { bin: '970432', short: 'VPB', name: 'VPBank' },
  { bin: '970423', short: 'TPB', name: 'TPBank' },
  { bin: '970403', short: 'STB', name: 'Sacombank' },
  { bin: '970437', short: 'HDB', name: 'HDBank' },
  { bin: '970441', short: 'VIB', name: 'VIB' },
  { bin: '970443', short: 'SHB', name: 'SHB' },
  { bin: '970448', short: 'OCB', name: 'OCB' },
  { bin: '970426', short: 'MSB', name: 'MSB' },
  { bin: '970431', short: 'EIB', name: 'Eximbank' },
  { bin: '970429', short: 'SCB', name: 'SCB' },
  { bin: '970440', short: 'SEAB', name: 'SeABank' },
  { bin: '970454', short: 'VCCB', name: 'Viet Capital Bank' },
  { bin: '970449', short: 'LPB', name: 'LPBank' },
  { bin: '970425', short: 'ABB', name: 'ABBANK' },
  { bin: '970409', short: 'BAB', name: 'Bac A Bank' },
  { bin: '970428', short: 'NAB', name: 'Nam A Bank' },
  { bin: '970419', short: 'NCB', name: 'NCB' },
  { bin: '970412', short: 'PVCB', name: 'PVcomBank' },
  { bin: '970414', short: 'MBV', name: 'MBV' },
  { bin: '970438', short: 'BVB', name: 'Bao Viet Bank' },
  { bin: '970433', short: 'VBB', name: 'VietBank' },
  { bin: '970452', short: 'KLB', name: 'Kienlongbank' },
  { bin: '970430', short: 'PGB', name: 'PG Bank' },
  { bin: '970400', short: 'SGB', name: 'Saigonbank' },
  { bin: '970427', short: 'VAB', name: 'VietABank' },
  { bin: '970444', short: 'CBB', name: 'CB Bank' },
  { bin: '970424', short: 'SHBVN', name: 'Shinhan Bank' },
  { bin: '970457', short: 'WOORI', name: 'Woori Bank' },
  { bin: '970434', short: 'IVB', name: 'Indovina Bank' },
  { bin: '970446', short: 'COOP', name: 'Co-opBank' },
  { bin: '668888', short: 'KBANK', name: 'KBank' },
  { bin: '422589', short: 'CIMB', name: 'CIMB' },
  { bin: '963388', short: 'TIMO', name: 'Timo' },
  { bin: '546034', short: 'CAKE', name: 'CAKE by VPBank' },
  { bin: '546035', short: 'UBANK', name: 'Ubank by VPBank' },
];

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase();

/** Banks whose name, abbreviation or BIN contains `query` (accents and case ignored). */
export function searchBanks(query: string): readonly Bank[] {
  const q = fold(query.trim());
  if (!q) return BANKS;
  return BANKS.filter(
    (bank) =>
      fold(bank.name).includes(q) ||
      fold(bank.short).includes(q) ||
      bank.bin.startsWith(q),
  );
}

export const bankByBin = (bin: string): Bank | undefined =>
  BANKS.find((bank) => bank.bin === bin);

/** "VCB" for a saved account; falls back to the list name, then the BIN of an unknown bank. */
export function bankLabel(account: {
  bank_bin: string;
  bank_short_name?: string | null;
}): string {
  return (
    account.bank_short_name ??
    bankByBin(account.bank_bin)?.short ??
    account.bank_bin
  );
}
