import { describe, expect, it } from 'vitest';
import { scoreLanguage } from './language.ts';

describe('scoreLanguage: vi', () => {
  it('accepts a Vietnamese answer', () => {
    expect(
      scoreLanguage(
        'Hôm nay bạn bán được 24 chai Coca Cola, doanh thu 1.234.000 ₫.',
        'vi',
      ),
    ).toBe(1);
    expect(scoreLanguage('Không có dữ liệu.', 'vi')).toBe(1);
  });

  it('accepts decomposed (NFD) Vietnamese', () => {
    expect(
      scoreLanguage('Hôm nay bạn bán được 24 chai.'.normalize('NFD'), 'vi'),
    ).toBe(1);
  });

  it('accepts Vietnamese without diacritics by function words', () => {
    expect(
      scoreLanguage(
        'Hom nay ban duoc 24 chai Coca va 12 chai Pepsi cua cua hang.',
        'vi',
      ),
    ).toBe(1);
  });

  it('rejects an English answer', () => {
    expect(
      scoreLanguage(
        'You sold 24 bottles of Coca Cola today and the revenue is high.',
        'vi',
      ),
    ).toBe(0);
  });

  it('accepts an answer with few Vietnamese letters at the 3 % threshold', () => {
    const filler = 'abcdefghij'.repeat(10); // 100 letters, 0 Vietnamese
    expect(scoreLanguage(`${filler}ăă`, 'vi')).toBe(0); // 2 / 102 = 2.0 %
    expect(scoreLanguage(`${filler}ăăăă`, 'vi')).toBe(1); // 4 / 104 = 3.8 %
    expect(scoreLanguage(`${filler}ă`, 'vi')).toBe(0); // 1 / 101
  });

  it('rejects an empty answer', () => {
    expect(scoreLanguage('', 'vi')).toBe(0);
    expect(scoreLanguage('   \n', 'vi')).toBe(0);
    expect(scoreLanguage('1.234.000 ₫', 'vi')).toBe(0);
  });
});

describe('scoreLanguage: en', () => {
  it('detects prose after removing known Vietnamese entity names only', () => {
    const names = ['Sữa đặc Ông Thọ', 'Bánh quy bơ', 'Nước mắm cá cơm'];
    expect(
      scoreLanguage(
        `There are three products: ${names.join(', ')}. They have not sold this month.`,
        'en',
        names,
      ),
    ).toBe(1);
    expect(
      scoreLanguage(
        `Có ba món: ${names.join(', ')}. Chúng chưa bán được trong tháng này.`,
        'en',
        names,
      ),
    ).toBe(0);
    expect(
      scoreLanguage(
        `The items are ${names.join(', ')}. Chúng chưa bán được trong tháng này và còn nhiều hàng.`,
        'en',
        names,
      ),
    ).toBe(0);
    expect(scoreLanguage(names.join(', '), 'en', names)).toBe(0);
    expect(
      scoreLanguage(
        'There are three products. They have not sold this month.',
        'vi',
        names,
      ),
    ).toBe(0);
  });
  it('accepts an English answer', () => {
    expect(
      scoreLanguage(
        'You sold 24 bottles of Coca Cola today. The revenue is 1,234,000 VND.',
        'en',
      ),
    ).toBe(1);
  });

  it('accepts English that quotes a Vietnamese product name', () => {
    expect(
      scoreLanguage(
        'The best seller this week is Sữa tươi Vinamilk, and it is the only item with more than 100 sales in the whole store this week.',
        'en',
      ),
    ).toBe(1);
  });

  it('rejects a Vietnamese answer', () => {
    expect(
      scoreLanguage('Hôm nay bạn bán được 24 chai Coca Cola, rất tốt.', 'en'),
    ).toBe(0);
    expect(
      scoreLanguage('Hom nay ban duoc 24 chai va 12 lon cua cua hang.', 'en'),
    ).toBe(0);
  });

  it('rejects an answer without English function words', () => {
    expect(scoreLanguage('Coca 24, Pepsi 12', 'en')).toBe(0);
    expect(scoreLanguage('the', 'en')).toBe(0);
  });

  it('rejects an empty answer', () => {
    expect(scoreLanguage('', 'en')).toBe(0);
  });
});
