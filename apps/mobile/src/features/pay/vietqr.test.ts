import {
  buildVietQr,
  crc16,
  tlv,
  vietQrMemo,
  type VietQrInput,
} from './vietqr';

const input: VietQrInput = {
  bankBin: '970436',
  accountNumber: '0123456789',
  amount: 49500,
  memo: 'TH 7KQ4MZ',
};

const BODY =
  '000201' +
  '010212' +
  '3854' +
  '0010A000000727' +
  '0124' +
  '000697043601100123456789' +
  '0208QRIBFTTA' +
  '5303704' +
  '540549500' +
  '5802VN' +
  '62130809TH 7KQ4MZ' +
  '6304';

describe('crc16', () => {
  it('matches the CRC-16/CCITT-FALSE check value for "123456789"', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('is the init value for empty input', () => {
    expect(crc16('')).toBe('FFFF');
  });

  it('pads to four uppercase hex digits', () => {
    expect(crc16('\u0000')).toMatch(/^[0-9A-F]{4}$/);
  });
});

describe('tlv', () => {
  it('encodes id, two-digit length and value', () => {
    expect(tlv('53', '704')).toBe('5303704');
    expect(tlv('00', '01')).toBe('000201');
    expect(tlv('01', '')).toBe('0100');
  });

  it('throws when the value is longer than 99 characters', () => {
    expect(() => tlv('62', 'x'.repeat(100))).toThrow(/too long/);
  });
});

describe('vietQrMemo', () => {
  it('strips diacritics (đ too) and clamps to 25 characters', () => {
    expect(vietQrMemo('Trả nợ Đỗ Văn Ân')).toBe('Tra no Do Van An');
    expect(vietQrMemo('Thanh toán đơn hàng số một hai ba bốn')).toBe(
      'Thanh toan don hang so mo',
    );
  });
});

describe('buildVietQr', () => {
  it('builds the full dynamic payload with a trailing CRC', () => {
    expect(buildVietQr(input)).toBe(BODY + crc16(BODY));
  });

  it('ends with 6304 and a CRC that validates the rest', () => {
    const payload = buildVietQr(input);
    expect(payload).toMatch(/6304[0-9A-F]{4}$/);
    expect(crc16(payload.slice(0, -4))).toBe(payload.slice(-4));
  });

  it('omits the amount tag when amount is 0 or missing', () => {
    expect(buildVietQr({ ...input, amount: 0 })).toContain('53037045802VN');
    expect(buildVietQr({ ...input, amount: undefined })).toContain(
      '53037045802VN',
    );
  });

  it('uses static initiation 11 when there is no amount', () => {
    expect(buildVietQr({ ...input, amount: 0 })).toContain('010211');
  });

  it('omits additional data when there is no memo', () => {
    const payload = buildVietQr({ ...input, memo: undefined });
    expect(payload).not.toContain('0809');
    expect(payload).not.toMatch(/62\d\d08/);
  });

  it('rounds the amount to whole đồng', () => {
    expect(buildVietQr({ ...input, amount: 1000.4 })).toContain('54041000');
  });

  it('strips diacritics from the memo and clamps it to 25 characters', () => {
    const payload = buildVietQr({
      ...input,
      memo: 'Thanh toán đơn hàng số một hai ba bốn',
    });
    expect(payload).toContain('0825Thanh toan don hang so ');
  });

  it('rejects an invalid BIN or account number', () => {
    expect(() => buildVietQr({ ...input, bankBin: '123' })).toThrow(/bank/i);
    expect(() => buildVietQr({ ...input, accountNumber: '' })).toThrow(
      /account/i,
    );
  });
});
