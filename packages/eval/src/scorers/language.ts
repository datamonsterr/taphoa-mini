/**
 * Is the answer in the requested language? Heuristic, no model call.
 * Vietnamese: Vietnamese-specific letters (ăâđêôơư and tone marks) are at
 * least 3 % of the letters, or 2 common Vietnamese function words appear.
 * English: under 5 % Vietnamese-specific letters (a quoted product name is
 * fine) and 2 common English function words.
 */

const VIETNAMESE_RATIO_MIN = 0.03;
const ENGLISH_RATIO_MAX = 0.05;
const WORDS_NEEDED = 2;

const VI_MARKS = /[̛̣̀́̂̃̆̉]/u;

const VI_WORDS = new Set([
  'và',
  'của',
  'là',
  'có',
  'không',
  'được',
  'trong',
  'cho',
  'các',
  'những',
  'một',
  'này',
  'đã',
  'sẽ',
  'với',
  'để',
  'khi',
  'nên',
  'bạn',
  'tôi',
  'mình',
  'hôm',
  'nay',
  'bán',
  'hàng',
  'còn',
  // Without diacritics, skipping words that are also English or names.
  'va',
  'cua',
  'khong',
  'duoc',
  'nhung',
  'cac',
  'nay',
  'voi',
  'toi',
  'nen',
]);

const EN_WORDS = new Set([
  'the',
  'is',
  'are',
  'and',
  'of',
  'to',
  'in',
  'you',
  'your',
  'for',
  'with',
  'that',
  'this',
  'have',
  'has',
  'was',
  'were',
  'it',
  'can',
  'not',
  'will',
  'from',
  'by',
  'at',
  'as',
  'be',
]);

function isVietnameseSpecific(letter: string): boolean {
  return letter === 'đ' || VI_MARKS.test(letter.normalize('NFD'));
}

function countDistinct(words: string[], list: Set<string>): number {
  return new Set(words.filter((w) => list.has(w))).size;
}

export function scoreLanguage(
  answer: string,
  lang: 'vi' | 'en',
  entityNames: readonly string[] = [],
): 0 | 1 {
  let text = answer.normalize('NFC').toLowerCase();
  // Names from resolved SQL facts must retain their display language. Only strip
  // those exact known names; arbitrary quoted text still participates in detection.
  if (lang === 'en') {
    for (const name of [...entityNames].sort((a, b) => b.length - a.length)) {
      if (name.trim())
        text = text.replaceAll(name.normalize('NFC').toLowerCase(), ' ');
    }
  }
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (letters.length === 0) return 0;

  const ratio = letters.filter(isVietnameseSpecific).length / letters.length;
  const words = text.match(/[\p{L}\p{M}]+/gu) ?? [];

  if (lang === 'vi') {
    return ratio >= VIETNAMESE_RATIO_MIN ||
      countDistinct(words, VI_WORDS) >= WORDS_NEEDED
      ? 1
      : 0;
  }
  return ratio < ENGLISH_RATIO_MAX &&
    countDistinct(words, EN_WORDS) >= WORDS_NEEDED
    ? 1
    : 0;
}
