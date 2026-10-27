/**
 * Number extraction for Vietnamese and English answers.
 *
 * Exact digit groups give `lo === hi === value`. An approximate form such as
 * `1,2 triệu` gives the range its last stated digit allows: [1 150 000, 1 250 000).
 * Percent values are percentage points (`12,5%` is 12.5). Dates, times and
 * codes glued to letters (`B12`) produce no numbers.
 */

export type NumberUnit = 'money' | 'percent' | 'count' | null;
export type ExtractedNumber = {
  value: number;
  lo: number;
  hi: number;
  unit: NumberUnit;
};

const SCALES: Record<string, number> = {
  k: 1e3,
  nghìn: 1e3,
  ngàn: 1e3,
  nghin: 1e3,
  ngan: 1e3,
  thousand: 1e3,
  tr: 1e6,
  triệu: 1e6,
  trieu: 1e6,
  million: 1e6,
  millions: 1e6,
  tỷ: 1e9,
  tỉ: 1e9,
  ty: 1e9,
  billion: 1e9,
};
const MONEY_WORDS = new Set(['₫', 'đ', 'đồng', 'dong', 'vnd', 'vnđ']);
const MEASURE_WORDS = new Set([
  'ml',
  'cl',
  'l',
  'lít',
  'lit',
  'mg',
  'g',
  'kg',
  'mm',
  'cm',
  'm',
]);

const WORD_AFTER = /^( ?)([\p{L}₫]+)/u;
const MONEY_PREFIX = /(?<![\p{L}])(?:vnd|vnđ)\s*$|₫\s*$/u;

/** Blank out dates, times and month/year labels so their digits are ignored. */
function maskDates(s: string): string {
  const blank = (m: string) => ' '.repeat(m.length);
  return s
    .replace(/\b\d{4}-\d{1,2}(?:-\d{1,2})?\b/g, blank)
    .replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, blank)
    .replace(/\b\d{1,2}\/\d{4}\b/g, blank)
    .replace(/\b(\d{1,2})\/(\d{1,2})\b/g, (m, a: string, b: string) =>
      Number(a) >= 1 && Number(a) <= 31 && Number(b) >= 1 && Number(b) <= 12
        ? blank(m)
        : m,
    )
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, blank);
}

function validThousands(intPart: string, sep: string): boolean {
  const groups = intPart.split(sep);
  return (
    groups[0]!.length <= 3 &&
    !groups[0]!.startsWith('0') &&
    groups.slice(1).every((g) => g.length === 3)
  );
}

/** Parse one digit token such as `1.234.000`, `12,5` or `1,234.56`. */
function parseDigits(
  raw: string,
  hasScale: boolean,
): { value: number; decimals: number } | null {
  const seps = raw.match(/[.,]/g) ?? [];
  if (seps.length === 0) return { value: Number(raw), decimals: 0 };

  if (new Set(seps).size === 2) {
    // The last separator is the decimal one, the other groups thousands.
    const last = seps[seps.length - 1]!;
    const thousands = last === ',' ? '.' : ',';
    const cut = raw.lastIndexOf(last);
    const intPart = raw.slice(0, cut);
    const frac = raw.slice(cut + 1);
    if (!validThousands(intPart, thousands)) return null;
    return {
      value: Number(`${intPart.split(thousands).join('')}.${frac}`),
      decimals: frac.length,
    };
  }

  const sep = seps[0]!;
  const groups = raw.split(sep);
  const thousandsShape = validThousands(raw, sep);
  if (seps.length > 1) {
    return thousandsShape
      ? { value: Number(groups.join('')), decimals: 0 }
      : null;
  }
  // One separator: 3 digits after it are a thousands group, unless a word
  // scale follows ("1,234 triệu"), where they are decimals.
  if (thousandsShape && !hasScale) {
    return { value: Number(groups.join('')), decimals: 0 };
  }
  return {
    value: Number(`${groups[0]}.${groups[1]}`),
    decimals: groups[1]!.length,
  };
}

const clean = (x: number) => Number(x.toPrecision(12));

function scaleOf(gap: string, word: string): number | undefined {
  // A lone "k" counts only when glued to the digits ("850k").
  if (word === 'k' && gap !== '') return undefined;
  return SCALES[word];
}

export function extractNumbers(text: string): ExtractedNumber[] {
  const s = maskDates(text.normalize('NFC').toLowerCase());
  const out: ExtractedNumber[] = [];
  const token = /\d+(?:[.,]\d+)*/gu;
  let m: RegExpExecArray | null;

  while ((m = token.exec(s)) !== null) {
    const start = m.index;
    let end = start + m[0].length;
    const before = s.slice(0, start);
    const prev = before.at(-1);
    const moneyPrefix = MONEY_PREFIX.test(before);
    if (prev !== undefined && /\p{L}/u.test(prev) && !moneyPrefix) continue;

    let negative = false;
    if (prev === '-' || prev === '−') {
      const beforeSign = before.at(-2);
      negative = beforeSign === undefined || !/[\p{L}\p{N}]/u.test(beforeSign);
    }

    const word = WORD_AFTER.exec(s.slice(end));
    const scale = word ? scaleOf(word[1]!, word[2]!) : undefined;
    const parsed = parseDigits(m[0], scale !== undefined);
    if (!parsed) continue;

    let value = parsed.value;
    let lo = value;
    let hi = value;
    let unit: NumberUnit = null;

    if (word && scale !== undefined) {
      end += word[0].length;
      value *= scale;
      let step = scale * 10 ** -parsed.decimals;
      let current = scale;
      // "1 triệu 200 nghìn" and "1 triệu 2": a smaller part follows.
      for (;;) {
        const part = /^ *(\d+(?:[.,]\d+)?)/.exec(s.slice(end));
        if (!part) break;
        const digits = part[1]!;
        const afterPart = s.slice(end + part[0].length);
        const next = WORD_AFTER.exec(afterPart);
        const nextScale = next ? scaleOf(next[1]!, next[2]!) : undefined;
        if (next && nextScale !== undefined && nextScale < current) {
          const sub = parseDigits(digits, true);
          if (!sub) break;
          value += sub.value * nextScale;
          step = nextScale * 10 ** -sub.decimals;
          current = nextScale;
          end += part[0].length + next[0].length;
          continue;
        }
        const bare = /^\d+$/.test(digits);
        const closed =
          !next || MONEY_WORDS.has(next[2]!) || !/^ ?\p{L}/u.test(afterPart);
        if (bare && closed && !/^ ?%/.test(afterPart)) {
          value += (Number(digits) * current) / 10 ** digits.length;
          step = current / 10 ** digits.length;
          end += part[0].length;
        }
        break;
      }
      lo = value - step / 2;
      hi = value + step / 2;
      unit = 'money';
    } else if (/^ ?%/.test(s.slice(end))) {
      unit = 'percent';
    } else if (word) {
      const w = word[2]!;
      if (MONEY_WORDS.has(w)) unit = 'money';
      else if (MEASURE_WORDS.has(w)) unit = null;
      else unit = 'count';
    }
    if (moneyPrefix && unit === null) unit = 'money';

    if (negative) {
      [value, lo, hi] = [-value, -hi, -lo];
    }
    out.push({ value: clean(value), lo: clean(lo), hi: clean(hi), unit });
    token.lastIndex = end;
  }
  return out;
}

/**
 * True when an extracted number's [lo, hi] range, widened by `tolerancePct`
 * percent, contains `expected`. The upper end of an approximate range is
 * exclusive at tolerance 0.
 */
export function matchNumber(
  text: string,
  expected: number,
  tolerancePct = 0.5,
): boolean {
  const t = tolerancePct / 100;
  return extractNumbers(text).some((n) => {
    const lo = n.lo - Math.abs(n.lo) * t;
    const hi = n.hi + Math.abs(n.hi) * t;
    if (n.lo === n.hi) return expected >= lo && expected <= hi;
    return expected >= lo && (t > 0 ? expected <= hi : expected < hi);
  });
}
