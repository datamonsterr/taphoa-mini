import { describe, expect, it } from 'vitest';
import { mentionsName } from './mentions.ts';

describe('mentionsName: catalog-style names', () => {
  it('matches "Coca-Cola lon 330ml" as "Coca Cola lon"', () => {
    expect(
      mentionsName(
        'Bạn còn 24 lon Coca Cola lon trong kho.',
        'Coca-Cola lon 330ml',
      ),
    ).toBe(true);
    expect(mentionsName('Coca Cola lon', 'Coca-Cola lon 330ml')).toBe(true);
    expect(mentionsName('Coca-Cola', 'Coca-Cola lon 330ml')).toBe(true);
    expect(mentionsName('COCA COLA', 'Coca-Cola lon 330ml')).toBe(true);
  });

  it('does not match a different product of the same brand family', () => {
    expect(
      mentionsName('Pepsi lon 330ml còn 12 lon', 'Coca-Cola lon 330ml'),
    ).toBe(false);
    expect(mentionsName('Coca', 'Coca-Cola lon 330ml')).toBe(false);
  });

  it('matches "Mì Hảo Hảo tôm chua cay 75g" as "mì Hảo Hảo tôm chua cay"', () => {
    const name = 'Mì Hảo Hảo tôm chua cay 75g';
    expect(mentionsName('Bán chạy: mì Hảo Hảo tôm chua cay.', name)).toBe(true);
    expect(mentionsName('Mì Hảo Hảo tôm chua cay 75g (30 gói)', name)).toBe(
      true,
    );
  });

  it('accepts the first 60 % of 4 or more core tokens as a phrase', () => {
    const name = 'Mì Hảo Hảo tôm chua cay 75g';
    // 6 core tokens, so the phrase is the first ceil(3.6) = 4: "mì hảo hảo tôm".
    expect(mentionsName('Top 1 là mì Hảo Hảo tôm.', name)).toBe(true);
    expect(mentionsName('Top 1 là mì Hảo Hảo.', name)).toBe(false);
  });

  it('needs all core tokens when the shorter phrase is absent', () => {
    const name = 'Mì Hảo Hảo tôm chua cay 75g';
    expect(mentionsName('Mì Hảo Hảo chua cay', name)).toBe(false);
    expect(mentionsName('tôm chua cay, mì, Hảo Hảo', name)).toBe(true);
  });

  it('does not use the 60 % phrase for names with fewer than 4 core tokens', () => {
    expect(mentionsName('Sữa tươi', 'Sữa tươi Vinamilk 180ml')).toBe(false);
  });

  it('does not match "Sữa tươi Vinamilk 180ml" with "Sữa đặc Ông Thọ"', () => {
    expect(mentionsName('Sữa đặc Ông Thọ', 'Sữa tươi Vinamilk 180ml')).toBe(
      false,
    );
    expect(mentionsName('Sữa tươi Vinamilk', 'Sữa tươi Vinamilk 180ml')).toBe(
      true,
    );
    expect(
      mentionsName('Sữa tươi Vinamilk 180ml', 'Sữa tươi Vinamilk 180ml'),
    ).toBe(true);
  });
});

describe('mentionsName: core tokens', () => {
  it.each([
    ['Nước suối Aquafina 1.5l', 'Nước suối Aquafina'],
    ['Nước suối Aquafina 500ml', 'nước suối aquafina'],
    ['Đường cát trắng 500 g', 'đường cát trắng'],
    ['Gạo ST25 túi 5kg', 'gạo ST25'],
    ['Bia Tiger thùng 24 lon', 'bia tiger'],
    ['Kẹo cao su Doublemint gói', 'Kẹo cao su Doublemint'],
  ])('drops size, number and unit tokens in %s', (name, answer) => {
    expect(mentionsName(answer, name)).toBe(true);
  });

  it('requires whole tokens', () => {
    expect(mentionsName('Colada', 'Cola')).toBe(false);
    expect(mentionsName('Pepsico', 'Pepsi')).toBe(false);
    expect(mentionsName('Cola', 'Cola')).toBe(true);
  });

  it('falls back to the full phrase when no core token remains', () => {
    expect(mentionsName('gói 330ml', '330ml')).toBe(true);
    expect(mentionsName('lon', '330ml')).toBe(false);
  });

  it('matches the full normalized name as a phrase', () => {
    expect(
      mentionsName('Còn Bánh quy Cosy 120g: 5 hộp', 'Bánh quy Cosy 120g'),
    ).toBe(true);
  });
});

describe('mentionsName: normalization', () => {
  it('ignores case, punctuation, hyphens and repeated spaces', () => {
    expect(mentionsName('"Coca   -  Cola", lon.', 'coca-cola LON')).toBe(true);
    expect(mentionsName('**Mì Hảo Hảo** (tôm)', 'Mì Hảo Hảo tôm')).toBe(true);
  });

  it('accepts decomposed (NFD) text on either side', () => {
    expect(
      mentionsName('Mì Hảo Hảo tôm'.normalize('NFD'), 'Mì Hảo Hảo tôm'),
    ).toBe(true);
    expect(
      mentionsName('Mì Hảo Hảo tôm', 'Mì Hảo Hảo tôm'.normalize('NFD')),
    ).toBe(true);
  });
});

describe('mentionsName: diacritics', () => {
  it('treats diacritics as significant', () => {
    expect(mentionsName('Hôm nay bán banh quy Cosy', 'Bánh quy Cosy')).toBe(
      false,
    );
    expect(mentionsName('Hôm nay bán bánh quy Cosy', 'Bánh quy Cosy')).toBe(
      true,
    );
    expect(mentionsName('Sữa tuoi Vinamilk', 'Sữa tươi Vinamilk')).toBe(false);
  });

  it('folds diacritics when the answer has none at all', () => {
    expect(mentionsName('Hom nay ban banh quy Cosy', 'Bánh quy Cosy')).toBe(
      true,
    );
    expect(mentionsName('Sua dac Ong Tho', 'Sữa đặc Ông Thọ')).toBe(true);
    expect(mentionsName('Sua tuoi Vinamilk', 'Sữa đặc Ông Thọ')).toBe(false);
  });

  it('matches a name that has no diacritics', () => {
    expect(mentionsName('Pepsi lon', 'Pepsi lon 330ml')).toBe(true);
  });
});

describe('mentionsName: empty input', () => {
  it('is false for an empty answer or name', () => {
    expect(mentionsName('', 'Coca Cola')).toBe(false);
    expect(mentionsName('Coca Cola', '')).toBe(false);
    expect(mentionsName('Coca Cola', '  - ')).toBe(false);
  });
});
