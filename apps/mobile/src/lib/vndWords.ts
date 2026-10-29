const DIGITS = [
  'không',
  'một',
  'hai',
  'ba',
  'bốn',
  'năm',
  'sáu',
  'bảy',
  'tám',
  'chín',
];
const SCALES = ['', 'nghìn', 'triệu', 'tỷ'];

/** One group of up to three digits; `full` keeps "không trăm" for inner groups. */
function group(n: number, full: boolean): string {
  const hundreds = Math.floor(n / 100);
  const tens = Math.floor((n % 100) / 10);
  const units = n % 10;
  const parts: string[] = [];
  if (hundreds > 0 || full) parts.push(`${DIGITS[hundreds]} trăm`);
  if (tens === 1) parts.push('mười');
  else if (tens > 1) parts.push(`${DIGITS[tens]} mươi`);
  else if (units > 0 && (hundreds > 0 || full)) parts.push('linh');
  if (units > 0) {
    if (units === 1 && tens > 1) parts.push('mốt');
    else if (units === 5 && tens > 0) parts.push('lăm');
    else parts.push(DIGITS[units]);
  }
  return parts.join(' ');
}

/** A whole-đồng amount in Vietnamese words: 15000 -> "mười lăm nghìn đồng". */
export function vndToWords(amount: number): string {
  const n = Math.max(0, Math.floor(amount));
  if (n === 0) return 'không đồng';
  if (!Number.isSafeInteger(n) || n >= 1e12) return `${n} đồng`;
  const groups: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) {
    groups.push(rest % 1000);
  }
  const out: string[] = [];
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const value = groups[i];
    if (value === 0) continue;
    const words = group(value, i < groups.length - 1);
    out.push(SCALES[i] ? `${words} ${SCALES[i]}` : words);
  }
  return `${out.join(' ')} đồng`;
}
