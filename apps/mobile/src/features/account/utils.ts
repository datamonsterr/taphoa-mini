const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/** First letter of the last word, upper-case; `?` when empty. */
export function initialOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const last = words[words.length - 1];
  return last ? last.charAt(0).toLocaleUpperCase('vi') : '?';
}

/** `0123456789` -> `0123 456 789`. */
export function formatAccountNumber(value: string): string {
  const head = value.slice(0, 4);
  const rest = value.slice(4).match(/.{1,3}/g) ?? [];
  return [head, ...rest].join(' ');
}

/** Groups an invite token by four characters. */
export function formatToken(token: string): string {
  return (token.match(/.{1,4}/g) ?? []).join(' ');
}

/** `HH:mm` of an ISO instant in Asia/Ho_Chi_Minh. */
export function formatExpiry(iso: string): string {
  const d = new Date(new Date(iso).getTime() + VN_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Upper-case, no diacritics: the form VietQR expects for the holder name. */
export function stripDiacritics(value: string): string {
  return value
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}
