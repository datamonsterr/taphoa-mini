/** VietQR (NAPAS / EMVCo merchant-presented QR) payload for an interbank transfer to an account. */

const NAPAS_GUID = 'A000000727';
const SERVICE_ACCOUNT = 'QRIBFTTA';
const CURRENCY_VND = '704';
const MEMO_MAX = 25;

export type VietQrInput = {
  /** 6-digit NAPAS bank BIN. */
  bankBin: string;
  accountNumber: string;
  /** Whole đồng. 0 or missing = static QR, payer types the amount. */
  amount?: number;
  /** Transfer note ("Nội dung"). Diacritics are stripped; clamped to 25 characters. */
  memo?: string;
};

/** Tag-length-value field: 2-digit id, 2-digit length, value. */
export function tlv(id: string, value: string): string {
  if (value.length > 99) throw new Error(`VietQR field ${id} too long`);
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021) as four uppercase hex digits. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= (text.charCodeAt(i) & 0xff) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function toAscii(text: string): string {
  return text
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function buildVietQr({
  bankBin,
  accountNumber,
  amount,
  memo,
}: VietQrInput): string {
  if (!/^\d{6}$/.test(bankBin)) throw new Error('Invalid bank BIN');
  if (!/^[0-9A-Za-z]{4,19}$/.test(accountNumber)) {
    throw new Error('Invalid account number');
  }
  const money = amount ? Math.round(amount) : 0;
  const beneficiary = tlv('00', bankBin) + tlv('01', accountNumber);
  const note = memo ? toAscii(memo).slice(0, MEMO_MAX) : '';
  const body =
    tlv('00', '01') +
    tlv('01', money > 0 ? '12' : '11') +
    tlv(
      '38',
      tlv('00', NAPAS_GUID) +
        tlv('01', beneficiary) +
        tlv('02', SERVICE_ACCOUNT),
    ) +
    tlv('53', CURRENCY_VND) +
    (money > 0 ? tlv('54', String(money)) : '') +
    tlv('58', 'VN') +
    (note ? tlv('62', tlv('08', note)) : '') +
    '6304';
  return body + crc16(body);
}
