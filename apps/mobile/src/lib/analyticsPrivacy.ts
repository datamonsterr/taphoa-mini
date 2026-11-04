/**
 * Last line of defence before an event leaves the phone. The typed event contract already
 * forbids personal data; this drops risky keys and masks emails and phone numbers in string
 * values, so a future prop can not send a customer's name or number to analytics by mistake.
 */
const PERSONAL_KEY =
  /name|email|phone|bank|token|ocr_text|note|address|contact|memo/i;
// `$screen_name` is PostHog's reserved screen property, not a person's name.
const ALLOWED_KEYS = new Set(['$screen_name']);

const EMAIL = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g;
// A phone starts with 0 or +, then digits with optional space, dot or dash separators.
const SEPARATED_PHONE = /(?<![\d\w])\+?0?\d(?:[ .-]?\d){8,14}(?![\d\w])/g;
// Any run of 9 to 15 digits is masked, as the backend does.
const DIGIT_RUN = /\d{9,15}/g;

export function maskText(text: string): string {
  return text
    .replace(EMAIL, '[email]')
    .replace(SEPARATED_PHONE, (match) => {
      const digits = match.replace(/\D/g, '').length;
      // "1.234.000" style money has 3-digit groups; keep it. Phones start with 0 or +.
      return digits >= 9 && (match.startsWith('0') || match.startsWith('+'))
        ? '[so]'
        : match;
    })
    .replace(DIGIT_RUN, '[so]');
}

export function scrubProps<T>(value: T): T {
  if (typeof value === 'string') return maskText(value) as T;
  if (Array.isArray(value)) return value.map(scrubProps) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => ALLOWED_KEYS.has(key) || !PERSONAL_KEY.test(key))
        .map(([key, child]) => [key, scrubProps(child)]),
    ) as T;
  }
  return value;
}
