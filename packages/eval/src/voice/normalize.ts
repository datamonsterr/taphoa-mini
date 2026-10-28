/** Lowercase, NFC, punctuation to space, one space between words. Keeps diacritics. */
export function normalizeVi(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `normalizeVi` without diacritics (`đ` becomes `d`). */
export function stripDiacritics(text: string): string {
  return normalizeVi(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd');
}

const words = (text: string) => (text === '' ? [] : text.split(' '));

/** Word-level Levenshtein distance. */
export function editDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

export type WerParts = { edits: number; words: number };

/** Edits and reference words after Vietnamese normalization; `wer = edits / words`. */
export function werParts(reference: string, hypothesis: string): WerParts {
  const ref = words(normalizeVi(reference));
  return {
    edits: editDistance(ref, words(normalizeVi(hypothesis))),
    words: ref.length,
  };
}

/** Same, with diacritics stripped on both sides. */
export function werPartsNoDiacritics(
  reference: string,
  hypothesis: string,
): WerParts {
  const ref = words(stripDiacritics(reference));
  return {
    edits: editDistance(ref, words(stripDiacritics(hypothesis))),
    words: ref.length,
  };
}

/** Word error rate of one pair; 0 for two empty texts, 1 for a hypothesis against an empty reference. */
export function wer(reference: string, hypothesis: string): number {
  const p = werParts(reference, hypothesis);
  return p.words === 0 ? (p.edits === 0 ? 0 : 1) : p.edits / p.words;
}

export function werNoDiacritics(reference: string, hypothesis: string): number {
  const p = werPartsNoDiacritics(reference, hypothesis);
  return p.words === 0 ? (p.edits === 0 ? 0 : 1) : p.edits / p.words;
}

/** Linear-interpolation-free percentile (nearest rank). `null` for no values. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}
