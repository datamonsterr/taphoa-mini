import { describe, expect, it } from 'vitest';
import {
  editDistance,
  normalizeVi,
  percentile,
  stripDiacritics,
  wer,
  werNoDiacritics,
  werParts,
} from './normalize.ts';

describe('normalizeVi', () => {
  it('lowercases, strips punctuation and keeps diacritics', () => {
    expect(normalizeVi('  Hai lon Coca, một lon PEPSI!  ')).toBe(
      'hai lon coca một lon pepsi',
    );
  });
  it('composes decomposed input to NFC', () => {
    const decomposed = 'một'; // "một" typed as o + dot + circumflex
    expect(normalizeVi(decomposed)).toBe(normalizeVi('một'));
    expect(normalizeVi(decomposed)).toBe('một'.normalize('NFC'));
  });
  it('treats hyphens and dots as separators', () => {
    expect(normalizeVi('Coca-Cola 1.5L')).toBe('coca cola 1 5l');
  });
});

describe('stripDiacritics', () => {
  it('drops marks and maps đ', () => {
    expect(stripDiacritics('Đường cát trắng')).toBe('duong cat trang');
  });
});

describe('wer', () => {
  it('is 0 for identical text apart from case and punctuation', () => {
    expect(wer('hai lon coca', 'Hai lon, Coca.')).toBe(0);
  });
  it('counts substitutions, insertions and deletions', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toBe(2);
    expect(wer('một hai ba bốn', 'một hai ba')).toBeCloseTo(0.25);
    expect(wer('một hai', 'một hai ba bốn')).toBeCloseTo(1);
  });
  it('counts a missing diacritic as an error, and the diacritic-free WER forgives it', () => {
    expect(wer('hai chục', 'hai chuc')).toBeCloseTo(0.5);
    expect(werNoDiacritics('hai chục', 'hai chuc')).toBe(0);
  });
  it('handles empty references', () => {
    expect(wer('', '')).toBe(0);
    expect(wer('', 'xin chào')).toBe(1);
    expect(werParts('hai ba', '')).toEqual({ edits: 2, words: 2 });
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const v = [5, 1, 3, 2, 4, 10, 9, 8, 7, 6];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});
