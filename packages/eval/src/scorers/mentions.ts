/**
 * Does an answer mention a catalog product name? Vietnamese-aware: both sides
 * are NFC, lower-cased, stripped of punctuation and hyphens. Diacritics
 * matter unless the answer has none at all.
 */

const UNIT_WORD_LIST = [
  'gói',
  'chai',
  'lon',
  'hộp',
  'thùng',
  'lốc',
  'bịch',
  'túi',
  'cái',
  'kg',
  'g',
  'ml',
  'l',
  'lít',
];
const SIZE_TOKEN = /^\d+(?:ml|cl|mg|kg|g|l|lít|lit)$/u;
const PURE_NUMBER = /^\d+$/u;
const VIETNAMESE_LETTER =
  /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/u;

/** Share of the core tokens, taken from the front, that also match alone. */
const PREFIX_SHARE = 0.6;
const PREFIX_MIN_TOKENS = 4;

function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function foldDiacritics(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gu, 'd')
    .normalize('NFC');
}

const UNIT_WORDS = new Set([
  ...UNIT_WORD_LIST,
  ...UNIT_WORD_LIST.map(foldDiacritics),
]);

function isDropped(token: string): boolean {
  return (
    PURE_NUMBER.test(token) || SIZE_TOKEN.test(token) || UNIT_WORDS.has(token)
  );
}

const hasPhrase = (haystack: string, phrase: string) =>
  ` ${haystack} `.includes(` ${phrase} `);

export function mentionsName(answer: string, name: string): boolean {
  let a = normalize(answer);
  let n = normalize(name);
  if (a === '' || n === '') return false;
  if (!VIETNAMESE_LETTER.test(a)) {
    a = foldDiacritics(a);
    n = foldDiacritics(n);
  }

  if (hasPhrase(a, n)) return true;

  const core = n.split(' ').filter((t) => !isDropped(t));
  if (core.length === 0) return false;
  const answerTokens = new Set(a.split(' '));
  if (core.every((t) => answerTokens.has(t))) return true;

  if (core.length >= PREFIX_MIN_TOKENS) {
    const keep = Math.ceil(core.length * PREFIX_SHARE);
    return hasPhrase(a, core.slice(0, keep).join(' '));
  }
  return false;
}
